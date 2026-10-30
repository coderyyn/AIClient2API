"""Paired release helpers. Each CLI mutation is a separate, resumable phase.

Private specs/state contain container environment and must stay root-only.
No credential rollback, database restore, or global allow fallback is provided.
"""
import argparse
import copy
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import time
import urllib.request
import urllib.error

from release_backup import digest, snapshot, write_json
from release import runtime_check
from release_maintenance import maintenance_text

SITE = '/etc/nginx/conf.d/beeintel-3000.conf'
DIRECTIVES = '/etc/nginx/snippets/edge-auth-api-directives.conf'
COMMON = '/etc/nginx/snippets/aiclient2api-proxy-common.conf'
DENIALS = '/etc/nginx/snippets/mainland-denials.conf'
SAFE_LOG = '/etc/nginx/conf.d/00-mainland-safe-log.conf'
COUNTRY = '/app/security/cn-ip-ranges.json'


def require(ok, message):
    if not ok:
        raise ValueError(message)


def run(args):
    return subprocess.check_output(args, text=True).strip()


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def http_json(url):
    with urllib.request.urlopen(url, timeout=5) as response:
        return json.load(response)


def key_set(config_dir):
    keys = json.loads((Path(config_dir) / 'api-potluck-keys.json').read_text())['keys']
    return {'count': len(keys), 'sha256': hashlib.sha256('\n'.join(sorted(keys)).encode()).hexdigest()}


def render_nginx(site, directives, common, denial_template, log_template):
    if 'mainland-denials.conf' in site:
        require(site.count('include ' + DENIALS + ';') == 2 and
                'error_page 500 = @mainland_edge_500;' in directives and
                'X-Edge-Denied-Status ""' in common, 'incomplete existing mainland ingress')
        return {SITE: site, DIRECTIVES: directives, COMMON: common, DENIALS: denial_template, SAFE_LOG: log_template}
    include = 'include /etc/nginx/snippets/edge-auth-location.conf;'
    require(site.count(include) == 2, 'unexpected virtual server topology')
    site = site.replace(include, include + '\n    include ' + DENIALS + ';')
    site = site.replace('access.log upstream_timing;', 'access.log aiclient_safe;')
    # Clear attacker-controlled deny headers even in locations without auth_request.
    site = site.replace('proxy_pass http://127.0.0.1:13000;',
                        'proxy_pass http://127.0.0.1:13000;\n        proxy_set_header X-Edge-Denied-Status "";')
    common += '\nproxy_set_header X-Edge-Denied-Status "";\n'
    # The common snippet clears this header. For direct locations the site does so.
    directives += '''
auth_request_set $edge_response_status $upstream_http_x_edge_response_status;
error_page 401 = @mainland_edge_401;
error_page 403 = @mainland_edge_403;
error_page 500 = @mainland_edge_500;
proxy_intercept_errors off;
'''
    require(re.findall(r'^\s*allow\s+[^;]+;', site, re.M) ==
            re.findall(r'^\s*allow\s+[^;]+;', site.replace('\n    include ' + DENIALS + ';', ''), re.M), 'allowlist drift')
    return {SITE: site, DIRECTIVES: directives, COMMON: common, DENIALS: denial_template, SAFE_LOG: log_template}


def payload(old, image, image_config, country_dir, gateway, revision, epoch, edge=False):
    config = copy.deepcopy(old['Config'])
    host = copy.deepcopy(old['HostConfig'])
    env = dict(s.split('=', 1) for s in config['Env'])
    base_env = dict(s.split('=', 1) for s in image_config.get('Env', []))
    if 'NODE_VERSION' in base_env:
        env['NODE_VERSION'] = base_env['NODE_VERSION']
    env.update(MAINLAND_CLIENT_KEYS_ONLY_REQUIRED='true', MAINLAND_COUNTRY_FILE=COUNTRY,
               YYN_EXPECTED_REVISION=revision, RUNTIME_DEPLOYMENT_EPOCH=epoch)
    if edge:
        env['EDGE_AUTH_TRUSTED_PROXY_IPS'] = gateway
        config['Cmd'] = ['node', 'src/edge-auth/server.js']
    config.update(Image=image, Env=[k + '=' + v for k, v in env.items()],
                  Labels={**(config.get('Labels') or {}), **(image_config.get('Labels') or {})},
                  Healthcheck=image_config['Healthcheck'])
    config['Hostname'] = ''
    host['Binds'] = list(dict.fromkeys([*(host.get('Binds') or []), country_dir + ':/app/security:ro']))
    host['CapDrop'] = sorted(set((host.get('CapDrop') or []) + ['NET_RAW']))
    host['SecurityOpt'] = sorted(set((host.get('SecurityOpt') or []) + ['no-new-privileges']))
    # Docker inspect-only fields are not create options.
    for name in ('ContainerIDFile',):
        host.pop(name, None)
    config['HostConfig'] = host
    network = host['NetworkMode']
    config['NetworkingConfig'] = {'EndpointsConfig': {network: {'Aliases': [old['Name'].lstrip('/')]}}}
    return config


def validate_created(old, new, country_dir):
    expected = copy.deepcopy(old['HostConfig'])
    expected['Binds'] = list(dict.fromkeys([*(expected.get('Binds') or []), country_dir + ':/app/security:ro']))
    expected['CapDrop'] = list(expected.get('CapDrop') or []) + ['NET_RAW']
    expected['SecurityOpt'] = list(expected.get('SecurityOpt') or []) + ['no-new-privileges']
    for key in ('PortBindings', 'Binds', 'NetworkMode', 'RestartPolicy', 'LogConfig', 'Memory', 'NanoCpus',
                'ExtraHosts', 'Privileged', 'CapAdd', 'CapDrop', 'SecurityOpt', 'ReadonlyRootfs', 'Dns',
                'Ulimits', 'Devices', 'PidMode', 'IpcMode', 'ShmSize', 'Init'):
        a, b = expected.get(key), new['HostConfig'].get(key)
        if key in ('CapDrop', 'CapAdd'):
            a, b = {v.removeprefix('CAP_') for v in a or []}, {v.removeprefix('CAP_') for v in b or []}
        if key in ('Binds', 'SecurityOpt'):
            a, b = set(a or []), set(b or [])
        if key == 'Dns' and not a and not b:
            continue
        require(a == b, 'unexpected host setting: ' + key)
    for key in ('User', 'WorkingDir', 'Entrypoint'):
        require(old['Config'].get(key) == new['Config'].get(key), 'unexpected container setting: ' + key)


class DockerConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect('/var/run/docker.sock')


def create(name, value):
    require(re.fullmatch(r'[a-zA-Z0-9_.-]+', name), 'unsafe name')
    conn = DockerConnection('localhost')
    conn.request('POST', '/v1.45/containers/create?name=' + name, json.dumps(value), {'Content-Type': 'application/json'})
    response = conn.getresponse()
    body = json.loads(response.read())
    require(response.status == 201, 'Docker create failed: ' + str(body.get('message')))
    return body['Id']


def replace_text(path, text):
    target = Path(path)
    temporary = target.with_name(target.name + '.mainland-tmp')
    require(not temporary.exists(), 'staging file already exists')
    temporary.write_text(text)
    os.chmod(temporary, 0o644)
    os.replace(temporary, target)


def nginx_reload():
    run(['nginx', '-t'])
    run(['nginx', '-s', 'reload'])


class Release:
    def __init__(self, spec, directory):
        self.spec = json.loads(Path(spec).read_text())
        self.root = Path(directory)
        self.statefile = self.root / 'state.private.json'
        self.state = json.loads(self.statefile.read_text()) if self.statefile.exists() else {}

    def save(self, **changes):
        self.state.update(changes)
        write_json(self.statefile, self.state)

    def check_keys(self):
        value = key_set(self.spec['configDir'])
        require(value == self.spec['keys'], 'client key set changed')
        return value

    def check_nginx(self, expected):
        for path, value in expected.items():
            require((digest(path) if Path(path).exists() else None) == value, 'Nginx changed: ' + path)

    def prepare(self):
        require(not self.state, 'already prepared')
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)
        self.check_keys()
        source = Path(self.spec['sourceDir'])
        olds = {role: inspect(role) for role in ('aiclient2api', 'edge-auth')}
        require(all(c['State']['Running'] for c in olds.values()), 'old containers not running')
        frozen = {}
        # Freeze every included Nginx config, so concurrent changes cannot be overwritten.
        nginx = run(['nginx', '-T'])
        for path in re.findall(r'^# configuration file ([^:]+):$', nginx, re.M):
            frozen[path] = digest(path)
        desired = render_nginx(Path(SITE).read_text(), Path(DIRECTIVES).read_text(), Path(COMMON).read_text(),
                               (source / 'docker/nginx-mainland-denial-locations.conf').read_text(),
                               (source / 'docker/nginx-mainland-safe-log.conf').read_text())
        for path in desired:
            if path in (DENIALS, SAFE_LOG) and Path(path).exists():
                require('mainland-denials.conf' in Path(SITE).read_text() and Path(path).read_text() == desired[path],
                        'existing mainland Nginx template changed; inspect before replacing')
            frozen.setdefault(path, digest(path) if Path(path).exists() else None)
        originals = {path: Path(path).read_text() if Path(path).exists() else None for path in desired}
        write_json(self.root / 'nginx-before.private.json', originals)
        write_json(self.root / 'nginx-desired.private.json', desired)
        write_json(self.root / 'containers-before.private.json', olds)
        write_json(self.root / 'config-before.private.json', json.loads((Path(self.spec['configDir']) / 'config.json').read_text()))
        snapshot(self.spec['configDir'], self.spec['configFiles'], self.root / 'snapshot')
        self.save(phase='prepared', oldIds={r: c['Id'] for r, c in olds.items()}, frozen=frozen,
                  configHash=digest(Path(self.spec['configDir']) / 'config.json'))
        return {'phase': 'prepared', 'keys': self.check_keys()}

    def create_role(self, role):
        require(self.state['phase'] == 'prepared', 'prepare first')
        self.check_nginx(self.state['frozen'])
        old = json.loads((self.root / 'containers-before.private.json').read_text())[role]
        require(inspect(role)['Id'] == old['Id'], 'active identity changed')
        image = self.spec['images'][role]
        image_config = inspect(image)['Config']
        require(image_config['Labels']['yyn.base_commit'] == self.spec['revision'], 'image revision mismatch')
        value = payload(old, image, image_config, self.spec['countryDir'], self.spec['gateway'],
                        self.spec['revision'], self.spec['epoch'], role == 'edge-auth')
        name = role + '-mainland-next'
        identifier = create(name, value)
        new = inspect(identifier)
        validate_created(old, new, self.spec['countryDir'])
        require(dict(s.split('=', 1) for s in new['Config']['Env']) ==
                dict(s.split('=', 1) for s in value['Env']), 'unexpected container environment')
        require(new['Config']['Cmd'] == value['Cmd'], 'unexpected command')
        require(new['Config']['Labels']['yyn.base_commit'] == self.spec['revision'], 'created revision mismatch')
        self.save(newIds={**self.state.get('newIds', {}), role: identifier})
        return {'created': role, 'id': identifier}

    def preview(self):
        require(self.state['phase'] == 'prepared', 'prepare first')
        self.check_nginx(self.state['frozen'])
        desired = json.loads((self.root / 'nginx-desired.private.json').read_text())
        tree = self.root / 'nginx-preview'
        require(not tree.exists(), 'preview already exists')
        # Copy config text only; certificate/private-key directives still refer to
        # the existing root-readable files. No credential contents are copied.
        for path in set(self.state['frozen']) | set(desired):
            text = desired.get(path)
            if text is None:
                text = Path(path).read_text()
            text = re.sub(r'(\binclude\s+)/etc/nginx/',
                          lambda m: m[1] + str(tree) + '/etc/nginx/', text)
            target = tree / path.lstrip('/')
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            target.write_text(text)
            os.chmod(target, 0o600)
        run(['nginx', '-t', '-c', str(tree / 'etc/nginx/nginx.conf')])
        self.save(previewPassed=True)
        return {'preview': 'passed'}

    def arm(self):
        require(self.state['phase'] == 'prepared' and len(self.state.get('newIds', {})) == 2
                and self.state.get('previewPassed'), 'precreate and validate preview first')
        self.check_nginx(self.state['frozen'])
        self.check_keys()
        require(digest(Path(self.spec['configDir']) / 'config.json') == self.state['configHash'], 'configuration changed')
        for role, identifier in self.state['oldIds'].items():
            require(inspect(role)['Id'] == identifier and inspect(role)['State']['Running'], 'old identity changed')
        gated = maintenance_text(Path(SITE).read_text())
        replace_text(SITE, gated)
        self.save(phase='maintenance', gateHash=digest(SITE))
        nginx_reload()
        return self.confirm_gate()

    def confirm_gate(self):
        require(self.state['phase'] in ('maintenance', 'drained'), 'no maintenance gate')
        require(digest(SITE) == self.state['gateHash'], 'maintenance gate changed')
        req = urllib.request.Request('http://127.0.0.1/v1/models', headers={'Host': self.spec['host']})
        # Reload is asynchronous: an immediately reused worker may still serve
        # the old config. Never permit a stop until a fresh probe confirms 503.
        for _ in range(20):
            try:
                with urllib.request.urlopen(req, timeout=5) as response:
                    status = response.status
            except urllib.error.HTTPError as exc:
                status = exc.code
            if status == 503:
                self.save(maintenanceVerified=True)
                return {'maintenance': True, 'verifiedStatus': 503}
            time.sleep(0.25)
        raise ValueError('maintenance probe not 503; do not stop old writer')

    def drain(self):
        require(self.state['phase'] in ('maintenance', 'drained') and self.state.get('maintenanceVerified'), 'verify gate first')
        deadline = time.monotonic() + 180
        stable = 0
        while time.monotonic() < deadline:
            value = http_json('http://127.0.0.1:13000/runtime/health')
            metrics = runtime_check(value, 3)
            flight = value['metrics']['inFlight']
            stable = stable + 1 if metrics['backlog'] == metrics['spooled'] == 0 else 0
            print(json.dumps({'inFlight': flight, 'stable': stable, **metrics}), flush=True)
            if stable >= 3 and flight <= 4:
                self.save(phase='drained', drain={'inFlight': flight, **metrics})
                return {'drained': True, 'interruptedUpperBound': flight}
            time.sleep(2)
        raise ValueError('drain timed out; cancel without stopping old containers')

    def stop_role(self, role):
        require(self.state['phase'] in ('drained', 'stopping') and self.state.get('maintenanceVerified'), 'drain with verified gate first')
        if role == 'edge-auth':
            require(not inspect(self.state['oldIds']['aiclient2api'])['State']['Running'], 'stop old writer first')
        identifier = self.state['oldIds'][role]
        require(inspect(role)['Id'] == identifier, 'old identity changed')
        timeout = 30 if self.state['drain']['inFlight'] else 120
        run(['docker', 'stop', '-t', str(timeout), identifier])
        state = inspect(identifier)['State']
        require(not state['Running'] and not state['OOMKilled'], 'old container stop failed/OOM')
        self.save(phase='stopping', stopped={**self.state.get('stopped', {}), role: state['ExitCode']})
        return {'stopped': role, 'exitCode': state['ExitCode']}

    def configure(self):
        require(len(self.state.get('stopped', {})) == 2, 'stop both old containers first')
        require(digest(SITE) == self.state['gateHash'], 'maintenance gate changed')
        self.check_nginx({p: sha for p, sha in self.state['frozen'].items() if p != SITE})
        self.check_keys()
        config_path = Path(self.spec['configDir']) / 'config.json'
        require(digest(config_path) == self.state['configHash'], 'config changed; do not overwrite')
        config = json.loads(config_path.read_text())
        config.update(MAINLAND_CLIENT_KEYS_ONLY=True, REQUEST_AUDIT_NETWORK_METADATA_ENABLED=True,
                      MAINLAND_COUNTRY_FILE_PATH=COUNTRY)
        proxies = config.get('TRUSTED_PROXY_IPS', [])
        require(isinstance(proxies, list), 'unexpected trusted proxy format')
        config['TRUSTED_PROXY_IPS'] = list(dict.fromkeys([*proxies, self.spec['gateway']]))
        write_json(config_path, config)
        desired = json.loads((self.root / 'nginx-desired.private.json').read_text())
        for path, text in desired.items():
            replace_text(path, maintenance_text(text) if path == SITE else text)
        self.save(phase='configured', configuredHash=digest(config_path), newGateHash=digest(SITE),
                  desiredHashes={path: hashlib.sha256(text.encode()).hexdigest() for path, text in desired.items()})
        nginx_reload()
        return {'configured': True, 'keys': self.check_keys()}

    def rename_old(self, role):
        require(self.state['phase'] == 'configured', 'configure first')
        identifier = self.state['oldIds'][role]
        require(not inspect(identifier)['State']['Running'], 'old still running')
        run(['docker', 'rename', identifier, role + '-before-mainland-' + self.spec['epoch']])
        return {'renamedOld': role}

    def rename_new(self, role):
        require(self.state['phase'] == 'configured', 'configure first')
        run(['docker', 'rename', self.state['newIds'][role], role])
        return {'renamedNew': role}

    def start_role(self, role):
        require(self.state['phase'] == 'configured', 'configure first')
        identifier = self.state['newIds'][role]
        require(inspect(role)['Id'] == identifier, 'new identity mismatch')
        require(not inspect(self.state['oldIds'][role])['State']['Running'], 'old writer still active')
        if role == 'aiclient2api':
            require(inspect(self.state['newIds']['edge-auth'])['State']['Running'], 'edge must start first')
        run(['docker', 'start', identifier])
        return {'started': role}

    def verify(self):
        value = http_json('http://127.0.0.1:13000/runtime/health')
        metrics = runtime_check(value, 3, self.spec['epoch'])
        require(metrics['backlog'] == metrics['spooled'] == 0, 'persistence not clear')
        geo = value.get('mainlandPolicy', {})
        require(geo.get('required') and geo.get('ready'), 'worker mainland policy not converged')
        edge = http_json('http://127.0.0.1:18081/health')['mainlandPolicy']
        require(edge['sha256'] == self.spec['countrySha'] and edge['available'], 'edge policy mismatch')
        # Worker status shape is reported verbatim in the private verification evidence.
        require(len(geo['workers']) == 4 and all(w.get('sha256') == self.spec['countrySha']
                for w in geo['workers'].values()), 'worker policy mismatch')
        for role, identifier in self.state['newIds'].items():
            actual = inspect(role)
            require(actual['Id'] == identifier and actual['State']['Running'] and not actual['State']['OOMKilled']
                    and actual['RestartCount'] == 0, 'new container unhealthy: ' + role)
        write_json(self.root / 'runtime-verified.json', {'runtime': value, 'edgePolicy': edge, 'keys': self.check_keys()})
        return {'readyWorkers': value['readyWorkers'], 'mainlandPolicy': geo, 'keys': self.check_keys()}

    def open(self):
        self.verify()
        require(digest(SITE) == self.state['newGateHash'], 'new gate changed')
        for path, sha in self.state['desiredHashes'].items():
            if path != SITE:
                require(digest(path) == sha, 'deployed Nginx file changed')
        text = json.loads((self.root / 'nginx-desired.private.json').read_text())[SITE]
        replace_text(SITE, text)
        nginx_reload()
        self.save(phase='open', openedAt=time.time())
        return {'productionOpen': True, 'revision': self.spec['revision']}

    def cancel(self):
        require(self.state['phase'] in ('maintenance', 'drained'), 'cannot cancel after old writer stopped; use paired rollback')
        for role, identifier in self.state['oldIds'].items():
            require(inspect(role)['Id'] == identifier and inspect(role)['State']['Running'], 'old service changed')
        require(digest(SITE) == self.state['gateHash'], 'gate changed')
        before = json.loads((self.root / 'nginx-before.private.json').read_text())
        replace_text(SITE, before[SITE])
        nginx_reload()
        self.save(phase='cancelled')
        return {'cancelled': True, 'oldServiceRestored': True}

    def rollback_gate(self):
        require(self.state['phase'] in ('configured', 'open'), 'no new release to roll back')
        expected = self.state['desiredHashes'][SITE] if self.state['phase'] == 'open' else self.state['newGateHash']
        require(digest(SITE) == expected, 'site changed; inspect before rollback')
        desired = json.loads((self.root / 'nginx-desired.private.json').read_text())
        replace_text(SITE, maintenance_text(desired[SITE]))
        nginx_reload()
        self.save(phase='rollback-maintenance', rollbackGateHash=digest(SITE))
        return {'maintenance': True, 'rollback': 'stop new pair before restoring old pair'}

    def rollback_ingress(self):
        require(self.state['phase'] == 'rollback-maintenance', 'gate before rollback')
        for identifier in self.state['newIds'].values():
            require(not inspect(identifier)['State']['Running'], 'stop new pair first')
        require(digest(SITE) == self.state['rollbackGateHash'], 'rollback gate changed')
        before = json.loads((self.root / 'nginx-before.private.json').read_text())
        for path, text in before.items():
            if path == SITE:
                replace_text(path, maintenance_text(text))
            elif text is None:
                require(digest(path) == self.state['desiredHashes'][path], 'new file changed; do not remove')
                Path(path).unlink()
            else:
                require(digest(path) == self.state['desiredHashes'][path], 'Nginx changed; do not overwrite')
                replace_text(path, text)
        nginx_reload()
        self.save(phase='rollback-ingress', rollbackGateHash=digest(SITE))
        return {'maintenance': True, 'restorePair': 'rename new containers aside; rename/start old edge then old main',
                'configRestored': False, 'clientIngressMustRemainInMaintenance': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spec', required=True)
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--phase', required=True, choices=['prepare', 'create', 'arm', 'drain', 'stop', 'configure',
                        'rename-old', 'rename-new', 'start', 'verify', 'open', 'preview', 'cancel',
                        'rollback-gate', 'rollback-ingress', 'confirm-gate'])
    parser.add_argument('--role', choices=['aiclient2api', 'edge-auth'])
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    release = Release(args.spec, args.state_dir)
    if not args.apply:
        print(json.dumps({'dryRun': True, 'phase': args.phase, 'keys': release.check_keys()}))
        return
    methods = {'create': 'create_role', 'stop': 'stop_role', 'start': 'start_role'}
    method = getattr(release, methods.get(args.phase, args.phase.replace('-', '_')))
    result = method(args.role) if args.phase in ('create', 'stop', 'start', 'rename-old', 'rename-new') else method()
    print(json.dumps(result))


if __name__ == '__main__':
    main()
