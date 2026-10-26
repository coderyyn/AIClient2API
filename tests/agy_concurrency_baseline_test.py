import importlib.util
from pathlib import Path
import unittest
import tempfile

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/ops/agy-concurrency-baseline.py'
spec = importlib.util.spec_from_file_location('agy_baseline', SCRIPT)
baseline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(baseline)
START = baseline.instant('2026-10-20T00:00:00Z')
END = START + 86400


def provider(name):
    return {'uuid': name, 'accountEmail': name + '@example.test'}


def event(key, name='a', minute=1, success=True, seconds=12, model='model-one'):
    timestamp = f'2026-10-20T00:{minute:02}:00Z'
    return {'requestId': key, 'timestamp': timestamp,
            'request': {'method': 'POST', 'normalizedPath': '/v1/chat/completions',
                        'toProvider': baseline.PROVIDER, 'actualModel': model, 'stream': True},
            'account': {'providerUuidHash': 'sha256:' + baseline.digest(name)},
            'status': {'outcome': 'success' if success else 'http_error', 'httpStatus': 200 if success else 429},
            'response': {'completed': True, 'durationMs': seconds * 1000, 'clientAborted': False},
            'attempts': [{'providerType': baseline.PROVIDER,
                          'providerUuidHash': 'sha256:' + baseline.digest(name),
                          'startedAt': timestamp, 'completedAt': f'2026-10-20T00:{minute:02}:{seconds:02}Z',
                          'durationMs': seconds * 1000, 'status': 'success' if success else 'error'}]}


class BaselineTests(unittest.TestCase):
    def analyze(self, events, providers=None, selected=None):
        return baseline.analyze(providers or [provider('a'), provider('b')], events, START, END, selected)

    def test_success_rpm_counts_failed_minutes_but_not_idle_minutes(self):
        report = self.analyze([event('1'), event('2', minute=2, success=False), event('3', 'b')])
        row = report['accounts'][0]
        self.assertEqual((row['successCount'], row['activeMinutes'], row['successRpm']), (1, 2, .5))
        self.assertEqual(row['failureRate'], .5)

    def test_duplicates_do_not_inflate_success(self):
        original = event('1')
        report = self.analyze([original, original, event('2', 'b')])
        self.assertEqual(report['accounts'][0]['successCount'], 1)
        self.assertEqual(report['excluded']['duplicateRecords'], 1)

    def test_final_fallback_success_not_credited_to_agy(self):
        original = event('1')
        original['request']['toProvider'] = 'other'
        original['account']['providerUuidHash'] = 'sha256:other'
        row = self.analyze([original])['accounts'][0]
        self.assertEqual((row['requestCount'], row['successCount']), (1, 0))

    def test_aborted_stream_is_not_success_and_uses_full_duration(self):
        aborted = event('abort')
        aborted['response']['clientAborted'] = True
        row = self.analyze([event('complete', seconds=30), aborted])['accounts'][0]
        self.assertEqual(row['successCount'], 1)
        self.assertEqual(row['meanSuccessDurationSeconds'], 30)

    def test_nonbusiness_probe_and_outside_window_are_excluded(self):
        probe = event('probe')
        probe['request']['normalizedPath'] = '/health'
        outside = event('old')
        outside['timestamp'] = '2026-10-19T23:59:59Z'
        self.assertEqual(self.analyze([probe, outside])['accounts'][0]['requestCount'], 0)

    def test_models_share_account_and_overlap_is_measured(self):
        row = self.analyze([event('1'), event('2', model='model-two')])['accounts'][0]
        self.assertEqual(row['successCount'], 2)
        self.assertEqual(row['observedPeakAttemptConcurrency'], 2)
        self.assertEqual(row['observedBusySecondsByConcurrency'], {2: 12})

    def test_formula_equal_weights_accounts_instead_of_request_counts(self):
        events = [event(str(i)) for i in range(10)] + [event('b', 'b', seconds=30)]
        result = self.analyze(events)['recommendation']
        self.assertEqual(result['meanAccountSuccessRpm'], 5.5)
        self.assertEqual(result['meanAccountDurationSeconds'], 21)
        self.assertEqual(result['concurrencyLimit'], 2)

    def test_missing_success_samples_gives_no_limit(self):
        self.assertIsNone(self.analyze([event('1')])['recommendation']['concurrencyLimit'])

    def test_three_accounts_require_explicit_selection(self):
        providers = [provider('a'), provider('b'), provider('c')]
        events = [event('1'), event('2', 'b'), event('3', 'c')]
        self.assertEqual(self.analyze(events, providers)['recommendation']['status'], 'blocked')
        selected = [baseline.digest('b'), baseline.digest('c')]
        self.assertEqual(self.analyze(events, providers, selected)['recommendation']['concurrencyLimit'], 1)

    def test_duplicate_identity_and_unknown_selection_block(self):
        providers = [provider('a'), {**provider('b'), 'accountEmail': 'a@example.test'}]
        report = self.analyze([event('1'), event('2', 'b')], providers)
        self.assertIn('duplicate_account_identities', report['recommendation']['blockers'])
        self.assertIsNone(self.analyze([], selected=['bad', 'ids'])['recommendation']['concurrencyLimit'])

    def test_missing_timing_blocks_candidate_and_nan_is_not_duration(self):
        item = event('1')
        item['attempts'][0]['durationMs'] = None
        item['response']['durationMs'] = None
        report = self.analyze([item, event('2', 'b')])
        self.assertIn('incomplete_timing_evidence', report['recommendation']['blockers'])
        self.assertIsNone(baseline.duration(float('nan')))

    def test_archived_uuid_is_merged_using_account_identity(self):
        providers = [provider('a'), provider('b'), {**provider('old'), 'accountEmail': 'a@example.test', 'isArchived': True}]
        row = self.analyze([event('1', 'old')], providers)['accounts'][0]
        self.assertEqual(row['successCount'], 1)

    def test_audit_email_attributes_uuid_missing_from_current_pool(self):
        item = event('1', 'old')
        item['account']['accountEmail'] = 'a@example.test'
        self.assertEqual(self.analyze([item])['accounts'][0]['successCount'], 1)

    def test_utc_rotated_and_gzip_files_are_discovered(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'archived-large').mkdir()
            names = ['audit-2026-10-20.jsonl', 'archived-large/audit-2026-10-20.jsonl.20261020T233200889Z',
                     'archived-large/audit-2026-10-20.jsonl.20261020T014201933Z.gz',
                     'audit-2026-10-19.jsonl', 'audit-2026-10-21.jsonl', 'unrelated.jsonl']
            for name in names:
                (root / name).touch()
            self.assertEqual(len(baseline.audit_files(root, START, END)), 3)


if __name__ == '__main__':
    unittest.main()
