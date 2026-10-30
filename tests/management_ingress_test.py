import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('ingress', Path(__file__).resolve().parents[1] / 'scripts/ops/prepare-management-ingress.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class IngressTest(unittest.TestCase):
    def test_keeps_separate_lists_and_does_not_reopen_missing_port(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template = 'server {\n location = / {\n allow ADDRESS;\n deny all;\n }\n}\n'
            (root / 'beeintel-3000.conf').write_text(template.replace('ADDRESS', '192.0.2.1'))
            module.render(root, root / 'domain-only')
            self.assertFalse((root / 'domain-only/aiclient2api-public-3000.conf').exists())
            (root / 'aiclient2api-public-3000.conf').write_text(template.replace('ADDRESS', '198.51.100.0/24'))
            module.render(root, root / 'both')
            policy = (root / 'both/00-aiclient-management-policy.conf').read_text()
            self.assertIn('192.0.2.1 1;', policy)
            self.assertIn('198.51.100.0/24 1;', policy)
            self.assertIn('"0:0" 1;', policy)
            self.assertIn('default 0;', policy)


if __name__ == '__main__':
    unittest.main()
