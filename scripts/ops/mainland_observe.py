"""Bounded, read-only post-cutover observation; never calls a model provider."""
import argparse
from collections import Counter
import datetime
import json
import re
from pathlib import Path
import time

from mainland_release import Release, http_json, inspect, require, key_set
from release import runtime_check
from release_backup import write_json


def audit_summary(config_dir, since):
    events = {}
    duplicates = 0
    for path in sorted((Path(config_dir) / 'request-audit').glob('audit-*.jsonl'))[-2:]:
        with path.open('rb') as stream:
            size = path.stat().st_size
            stream.seek(max(0, size - 8 * 1024 * 1024))
            if stream.tell():
                stream.readline()
            for line in stream:
                try:
                    event = json.loads(line)
                    stamp = datetime.datetime.fromisoformat(event['timestamp'].replace('Z', '+00:00')).timestamp()
                except (ValueError, KeyError):
                    continue
                if stamp < since or not event.get('potluckKey', {}).get('present'):
                    continue
                identifier = event.get('requestId')
                if identifier in events:
                    duplicates += 1
                events[identifier] = event
    decisions, outcomes, statuses = Counter(), Counter(), Counter()
    malformed, unavailable = [], []
    samples = []
    for identifier, event in events.items():
        network = event.get('network', {})
        policy = network.get('mainlandPolicy', {})
        geographic_codes = {'MAINLAND_CN', 'CLIENT_IP_NOT_MAINLAND', 'CLIENT_IP_UNVERIFIABLE', 'COUNTRY_POLICY_UNAVAILABLE'}
        if not identifier or not all(network.get(k) for k in ('clientIp', 'peerIp', 'clientIpSource')) or policy.get('code') not in geographic_codes or not re.fullmatch(r'sha256:[0-9a-f]{16}', event['potluckKey'].get('hash') or ''):
            malformed.append(identifier)
        if policy.get('code') == 'COUNTRY_POLICY_UNAVAILABLE':
            unavailable.append(identifier)
        decisions[policy.get('code', 'missing')] += 1
        outcomes[event.get('status', {}).get('outcome', 'missing')] += 1
        statuses[str(event.get('response', {}).get('httpStatus'))] += 1
        if len(samples) < 12:
            samples.append({'requestId': identifier, 'clientIp': network.get('clientIp'),
                            'peerIp': network.get('peerIp'), 'clientIpSource': network.get('clientIpSource'),
                            'keyHash': event['potluckKey'].get('hash'), 'policy': policy,
                            'httpStatus': event.get('response', {}).get('httpStatus')})
    return {'events': len(events), 'decisions': dict(decisions), 'outcomes': dict(outcomes),
            'statuses': dict(statuses), 'duplicates': duplicates, 'malformed': malformed,
            'policyUnavailable': unavailable, 'samples': samples,
            'scan': 'latest two JSONL files, last 8 MiB each; no raw content returned'}


def observe(spec_file, state_dir, seconds=600):
    release = Release(spec_file, state_dir)
    require(release.state['phase'] == 'open', 'production not open')
    require(seconds >= 600, 'observe at least ten minutes')
    start = release.state['openedAt']
    deadline = max(time.time(), start) + seconds
    samples = []
    while True:
        value = http_json('http://127.0.0.1:13000/runtime/health')
        metrics = runtime_check(value, 3, release.spec['epoch'])
        require(value.get('potluckKeyConfig', {}).get('pendingWorkerCount') == 0,
                'key configuration not converged')
        require(value.get('mainlandPolicy', {}).get('ready'), 'policy no longer ready')
        edge = http_json('http://127.0.0.1:18081/health')['mainlandPolicy']
        require(edge.get('sha256') == release.spec['countrySha'] and edge.get('available'), 'edge policy changed')
        for policy in value['mainlandPolicy']['workers'].values():
            require(policy.get('sha256') == release.spec['countrySha'] and policy.get('available'), 'worker policy changed')
        containers = {}
        for role, identifier in release.state['newIds'].items():
            c = inspect(role)
            require(c['Id'] == identifier and c['State']['Running'] and not c['State']['OOMKilled']
                    and c['RestartCount'] == 0, 'container changed/restarted/OOM')
            containers[role] = {'id': identifier, 'image': c['Image'],
                                'health': c['State'].get('Health', {}).get('Status'),
                                'restartCount': c['RestartCount'], 'oom': c['State']['OOMKilled']}
        require(key_set(release.spec['configDir']) == release.spec['keys'], 'key set changed')
        release.check_nginx(release.state['desiredHashes'])
        release.check_nginx({p: sha for p, sha in release.state['frozen'].items()
                             if p not in release.state['desiredHashes']})
        audit = audit_summary(release.spec['configDir'], start)
        require(not audit['malformed'] and not audit['policyUnavailable'] and audit['duplicates'] == 0,
                'new client audit missing metadata, unavailable policy, or duplicate request')
        sample = {'timestamp': time.time(), 'readyWorkers': value['readyWorkers'],
                  'inFlight': value['metrics']['inFlight'], **metrics,
                  'auditedClientRequests': audit['events'], 'decisions': audit['decisions'],
                  'statuses': audit['statuses']}
        samples.append(sample)
        report = {'status': 'observing',
                  'revision': release.spec['revision'], 'startedAt': start,
                  'elapsedSeconds': time.time() - start, 'samples': samples, 'audit': audit,
                  'containers': containers, 'keys': release.spec['keys'],
                  'paidTestCalls': 0, 'healthChecks': 'existing production background behavior preserved'}
        write_json(Path(state_dir) / 'production-observation.private.json', report)
        print(json.dumps(sample), flush=True)
        if time.time() >= deadline:
            require(metrics['backlog'] == metrics['spooled'] == 0, 'final persistence not clear')
            require(audit['events'] > 0, 'no client audit evidence')
            report['status'] = 'passed'
            write_json(Path(state_dir) / 'production-observation.private.json', report)
            return report
        time.sleep(min(30, max(0, deadline - time.time())))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spec', required=True)
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--seconds', type=int, default=600)
    args = parser.parse_args()
    report = observe(args.spec, args.state_dir, args.seconds)
    print(json.dumps({'status': report['status'], 'elapsedSeconds': report['elapsedSeconds'],
                      'clientRequests': report['audit']['events']}))
