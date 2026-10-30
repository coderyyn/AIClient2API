"""Pure release contracts: preserve resource/identity settings and fail on drift."""
import copy
import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/ops'))
import mainland_release as release


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
        with self.assertRaises(ValueError):
            release.render_nginx(result[release.SITE], '', '', '', '')


if __name__ == '__main__':
    unittest.main()
