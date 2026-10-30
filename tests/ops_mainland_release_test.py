"""Pure release contracts: preserve resource/identity settings and fail on drift."""
import copy
import sys
from pathlib import Path
import unittest
import tempfile
import urllib.error
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/ops'))
import mainland_release as release
from mainland_observe import audit_summary


class MainlandReleaseTests(unittest.TestCase):
    def old(self):
        return {'Name': '/aiclient2api', 'Config': {'Env': ['KEEP=x', 'NODE_VERSION=22'],
                'User': '', 'WorkingDir': '/app', 'Entrypoint': ['entrypoint'], 'Cmd': ['node', 'main.js']},
                'HostConfig': {'Binds': ['/root/config:/app/configs:rw'], 'NetworkMode': 'prod',
                'Memory': 0, 'NanoCpus': 0, 'CapDrop': None, 'SecurityOpt': None,
                'PortBindings': {'3000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '13000'}]}}}

    def test_only_approved_runtime_changes(self):
        old = self.old()
        before = copy.deepcopy(old)
        value = release.payload(old, 'newimage', {'Env': ['NODE_VERSION=24'], 'Healthcheck': {'Test': ['CMD', 'node']}},
                                '/root/country', '172.21.0.1', 'revision', 'epoch')
        self.assertEqual(old, before)
        created = {'Config': value, 'HostConfig': value['HostConfig']}
        release.validate_created(old, created, '/root/country')
        self.assertIn('KEEP=x', value['Env'])
        self.assertIn('MAINLAND_CLIENT_KEYS_ONLY_REQUIRED=true', value['Env'])
        self.assertEqual(value['HostConfig']['Memory'], 0)
        self.assertEqual(value['HostConfig']['NanoCpus'], 0)
        value['HostConfig']['PortBindings'] = {}
        with self.assertRaisesRegex(ValueError, 'PortBindings'):
            release.validate_created(old, created, '/root/country')

    def test_nginx_keeps_allowlist_and_clears_untrusted_header(self):
        site = ('server {\nserver_name example;\nallow 1.2.3.4;\n'
                'include /etc/nginx/snippets/edge-auth-location.conf;\n'
                'proxy_pass http://127.0.0.1:13000;\n}\n') * 2
        result = release.render_nginx(site, 'auth_request /_edge_auth;\n', 'proxy_pass http://127.0.0.1:13000;', 'denials', 'logs')
        self.assertEqual(result[release.SITE].count('allow 1.2.3.4;'), 2)
        self.assertEqual(result[release.SITE].count('X-Edge-Denied-Status ""'), 2)
        self.assertIn('error_page 500 = @mainland_edge_500;', result[release.DIRECTIVES])
        again = release.render_nginx(result[release.SITE], result[release.DIRECTIVES], result[release.COMMON], 'denials', 'logs')
        self.assertEqual(result, again)
        with self.assertRaises(ValueError):
            release.render_nginx(result[release.SITE], '', '', '', '')

    def gate_release(self, directory):
        target = Path(directory) / 'site.conf'
        target.write_text('maintenance')
        r = object.__new__(release.Release)
        r.state = {'phase': 'maintenance', 'gateHash': release.digest(target)}
        r.spec = {'host': 'example.test'}
        r.save = Mock()
        return r, target

    def test_asynchronous_reload_must_confirm_503_before_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            r, target = self.gate_release(directory)
            replies = [urllib.error.HTTPError('test', code, '', {}, None) for code in (401, 503)]
            with patch.object(release, 'SITE', str(target)), patch.object(release.time, 'sleep'), \
                    patch.object(release.urllib.request, 'urlopen', side_effect=replies):
                self.assertEqual(r.confirm_gate()['verifiedStatus'], 503)
            r.save.assert_called_once_with(maintenanceVerified=True)

    def test_unverified_gate_cannot_stop_old_writer(self):
        r = object.__new__(release.Release)
        r.state = {'phase': 'drained'}
        with patch.object(release, 'run') as mutation:
            with self.assertRaisesRegex(ValueError, 'verified gate'):
                r.stop_role('aiclient2api')
            mutation.assert_not_called()

    def test_audit_observer_detects_missing_metadata_and_duplicate_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'request-audit'
            root.mkdir()
            event = {'timestamp': '2026-10-30T10:00:00Z', 'requestId': 'synthetic',
                     'potluckKey': {'present': True, 'hash': 'sha256:' + 'a' * 16},
                     'network': {'clientIp': '114.114.114.114', 'peerIp': '172.21.0.1',
                                 'clientIpSource': 'trusted-x-real-ip', 'mainlandPolicy': {'code': 'MAINLAND_CN'}}}
            path = root / 'audit-2026-10-30.jsonl'
            path.write_text(release.json.dumps(event) + '\n')
            result = audit_summary(directory, 0)
            self.assertEqual(result['events'], 1)
            self.assertEqual(result['malformed'], [])
            event['network']['clientIp'] = None
            path.write_text((release.json.dumps(event) + '\n') * 2)
            result = audit_summary(directory, 0)
            self.assertEqual(result['malformed'], ['synthetic'])
            self.assertEqual(result['duplicates'], 1)


if __name__ == '__main__':
    unittest.main()
