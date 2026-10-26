"""Read-only AGY throughput baseline. Outputs hashes and aggregates, never raw audit data.

Run locally, or pipe this source to `ssh <host> python3 - --config-dir <dir>`.
Only reads provider metadata and audit JSONL; does not read OAuth credential files.
"""
import argparse
import collections
import datetime as dt
import hashlib
import gzip
import itertools
import json
import math
from pathlib import Path
import re

PROVIDER = 'gemini-antigravity'


def digest(value):
    return hashlib.sha256(str(value).encode()).hexdigest()[:16]


def instant(value):
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return parsed.timestamp() if parsed.tzinfo else None
    except (ValueError, TypeError):
        return None


def duration(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) and number >= 0 else None
    except (ValueError, TypeError):
        return None


def percentile(values, fraction):
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)] if values else None


def business(event):
    request = event.get('request') or {}
    path = request.get('normalizedPath') or request.get('path') or ''
    return request.get('method', 'POST') == 'POST' and bool(re.search(
        r'/(chat/completions|responses|messages|images/(generations|edits))$|:streamGenerateContent$|:generateContent$', path))


def recommendation(rows):
    if not rows or any(not row['successCount'] or row['meanSuccessDurationSeconds'] is None for row in rows):
        return {'status': 'insufficient_samples', 'concurrencyLimit': None}
    rpm = sum(row['successRpm'] for row in rows) / len(rows)
    seconds = sum(row['meanSuccessDurationSeconds'] for row in rows) / len(rows)
    return {'status': 'candidate_requires_load_validation', 'meanAccountSuccessRpm': rpm,
            'meanAccountDurationSeconds': seconds,
            'concurrencyLimit': max(1, math.ceil(rpm * seconds / 60)), 'queueLimit': 0}


def account_identity(provider):
    email = (provider.get('accountEmail') or '').strip().lower()
    if not email:
        match = re.search(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', provider.get('customName') or '')
        email = match.group().lower() if match else ''
    return email


def audit_files(root, start, end):
    """Match the store's UTC daily names, including rotated and compressed shards."""
    pattern = re.compile(r'^audit-(\d{4}-\d{2}-\d{2})\.jsonl(?:\.\d{8}T\d{9}Z(?:\.\d+)?)?(?:\.gz)?$')
    files = []
    for directory in [root, root / 'archived-large']:
        if not directory.exists():
            continue
        for path in directory.iterdir():
            match = pattern.match(path.name)
            if not match or not path.is_file():
                continue
            day_start = instant(match[1] + 'T00:00:00Z')
            if day_start < end and day_start + 86400 > start:
                files.append(path)
    return sorted(files)


def analyze(providers, events, start, end, selected_ids=None):
    active = [p for p in providers if not p.get('isArchived') and not p.get('isDisabled')]
    accounts = {}
    identities = collections.defaultdict(list)
    for provider in active:
        account_id = digest(provider['uuid'])
        identity = account_identity(provider)
        if identity:
            identities[digest(identity)].append(account_id)
        accounts['sha256:' + account_id] = {
            'id': account_id, 'identityKnown': bool(identity),
            'identityHash': digest(identity) if identity else None,
            'configuredConcurrencyLimit': provider.get('concurrencyLimit', 0),
            'configuredQueueLimit': provider.get('queueLimit', 0),
            'minutes': set(), 'requests': set(), 'success': set(), 'durations': [],
            'intervals': [], 'missingDurationCount': 0, 'unresolvedAttemptCount': 0,
            'fallbackDurationCount': 0, 'models': collections.Counter(),
            'requestStarts': [], 'httpStatuses': collections.Counter(),
            'beijingTodaySuccessCount': 0, 'beijingTodayHttp200Count': 0,
        }

    identity_owners = {identity: 'sha256:' + ids[0] for identity, ids in identities.items() if len(ids) == 1}
    aliases = {}
    for provider in providers:
        identity = account_identity(provider)
        if identity and digest(identity) in identity_owners:
            aliases['sha256:' + digest(provider['uuid'])] = identity_owners[digest(identity)]

    deduplicated = {}
    excluded = collections.Counter()
    for index, event in enumerate(events):
        timestamp = instant(event.get('timestamp'))
        if timestamp is None or not start <= timestamp < end:
            continue
        if not business(event):
            excluded['nonBusiness'] += 1
            continue
        attempts = event.get('attempts') or []
        if (event.get('request') or {}).get('toProvider') != PROVIDER and not any(a.get('providerType') == PROVIDER for a in attempts):
            continue
        key = event.get('requestId') or event.get('eventId')
        if not key:
            excluded['missingRequestIdentity'] += 1
            continue
        score = (bool((event.get('response') or {}).get('completed')), len(attempts),
                 duration((event.get('response') or {}).get('durationMs')) is not None, timestamp)
        if key in deduplicated:
            excluded['duplicateRecords'] += 1
        if key not in deduplicated or score > deduplicated[key][0]:
            # Do not retain prompts, diagnostics, network identities or raw captures.
            compact = {field: event.get(field) for field in ('timestamp', 'request', 'account', 'status', 'response')}
            compact['attempts'] = [{field: attempt.get(field) for field in
                ('startedAt', 'completedAt', 'durationMs', 'providerType', 'providerUuidHash', 'status')}
                for attempt in attempts]
            deduplicated[key] = (score, compact)

    for key, (_, event) in deduplicated.items():
        timestamp = instant(event['timestamp'])
        response = event.get('response') or {}
        beijing_zone = dt.timezone(dt.timedelta(hours=8))
        is_today = (dt.datetime.fromtimestamp(timestamp, beijing_zone).date()
                    == dt.datetime.fromtimestamp(end, beijing_zone).date())
        attempts = event.get('attempts') or []
        owned = collections.defaultdict(list)
        account = event.get('account') or {}
        final_raw_hash = account.get('providerUuidHash')
        final_hash = aliases.get(final_raw_hash, final_raw_hash)
        identity = account_identity(account)
        if identity and digest(identity) in identity_owners:
            final_hash = identity_owners[digest(identity)]
        for attempt in attempts:
            attempt_hash = aliases.get(attempt.get('providerUuidHash'), attempt.get('providerUuidHash'))
            if attempt.get('providerUuidHash') == final_raw_hash:
                attempt_hash = final_hash
            if attempt.get('providerType') == PROVIDER and attempt_hash in accounts:
                owned[attempt_hash].append(attempt)
        if not owned and final_hash in accounts and (event.get('request') or {}).get('toProvider') == PROVIDER:
            total_ms = duration(response.get('durationMs'))
            owned[final_hash] = [{'startedAt': None, 'completedAt': None, 'durationMs': total_ms, '_fallback': True}]
        for owner, owner_attempts in owned.items():
            row = accounts[owner]
            row['requests'].add(key)
            row['httpStatuses'][str((event.get('status') or {}).get('httpStatus'))] += 1
            if is_today and final_hash == owner and response.get('httpStatus') == 200:
                row['beijingTodayHttp200Count'] += 1
            for attempt in owner_attempts:
                ms = duration(attempt.get('durationMs'))
                finish = instant(attempt.get('completedAt'))
                began = instant(attempt.get('startedAt'))
                if began is None and attempt.get('_fallback') and ms is not None:
                    began = timestamp - ms / 1000
                    finish = timestamp
                if began is not None and start <= began < end:
                    row['minutes'].add(int(began // 60))
                    row['requestStarts'].append(began)
                elif began is None:
                    row['minutes'].add(int(timestamp // 60))
                    row['unresolvedAttemptCount'] += 1
                if began is not None and finish is not None and finish >= began:
                    row['intervals'].append((max(start, began), min(end, finish)))
            final_success = ((event.get('status') or {}).get('outcome') == 'success'
                             and response.get('completed') is True and not response.get('clientAborted')
                             and final_hash == owner and (event.get('request') or {}).get('toProvider') == PROVIDER)
            if final_success:
                row['success'].add(key)
                row['beijingTodaySuccessCount'] += int(is_today)
                row['models'][(event.get('request') or {}).get('actualModel') or 'unknown'] += 1
                successful = [a for a in owner_attempts if a.get('status') == 'success']
                ms = duration(successful[-1].get('durationMs')) if successful else None
                if ms is None and len(attempts) <= 1:
                    ms = duration(response.get('durationMs'))
                    row['fallbackDurationCount'] += int(ms is not None)
                if ms is None:
                    row['missingDurationCount'] += 1
                else:
                    row['durations'].append(ms / 1000)

    rows = []
    for row in accounts.values():
        intervals = [(a, b) for a, b in row.pop('intervals') if b > a]
        changes = sorted([(a, 1) for a, b in intervals] + [(b, -1) for a, b in intervals])
        current = peak = 0
        occupancy_seconds = collections.defaultdict(float)
        previous = None
        for at, change in changes:
            if previous is not None and current > 0 and at > previous:
                occupancy_seconds[current] += at - previous
            current += change
            peak = max(peak, current)
            previous = at
        seconds = row.pop('durations')
        request_count, success_count = len(row.pop('requests')), len(row.pop('success'))
        minutes = len(row.pop('minutes'))
        starts = row.pop('requestStarts')
        rows.append({**row, 'requestCount': request_count, 'successCount': success_count,
                     'failureCount': request_count - success_count,
                     'failureRate': (request_count - success_count) / request_count if request_count else None,
                     'activeMinutes': minutes, 'successRpm': success_count / minutes if minutes else 0,
                     'durationSampleCount': len(seconds),
                     'meanSuccessDurationSeconds': sum(seconds) / len(seconds) if seconds else None,
                     'p95SuccessDurationSeconds': percentile(seconds, .95),
                     'maxSuccessDurationSeconds': max(seconds) if seconds else None,
                     'over60SecondsCount': sum(s > 60 for s in seconds),
                     'observedPeakAttemptConcurrency': peak,
                     'observedBusySecondsByConcurrency': dict(sorted(occupancy_seconds.items())),
                     'firstRequestAt': dt.datetime.fromtimestamp(min(starts), dt.timezone.utc).isoformat() if starts else None,
                     'lastRequestAt': dt.datetime.fromtimestamp(max(starts), dt.timezone.utc).isoformat() if starts else None})
    selected = [r for r in rows if not selected_ids or r['id'] in selected_ids]
    duplicates = [ids for ids in identities.values() if len(ids) > 1]
    blockers = []
    if len(selected) != 2 or (selected_ids and set(selected_ids) != {r['id'] for r in selected}):
        blockers.append('exactly_two_current_accounts_must_be_selected')
    if duplicates:
        blockers.append('duplicate_account_identities')
    if any(not r['identityKnown'] for r in selected):
        blockers.append('account_identity_unverified')
    if any(r['missingDurationCount'] or r['unresolvedAttemptCount'] for r in selected):
        blockers.append('incomplete_timing_evidence')
    result = recommendation(selected) if len(selected) == 2 else {'concurrencyLimit': None}
    if blockers:
        result = {**result, 'status': 'blocked', 'concurrencyLimit': None, 'blockers': blockers}
    if result.get('concurrencyLimit'):
        limit = result['concurrencyLimit']
        result['historicalLoadCheck'] = [{
            'id': row['id'], 'observedPeakAttemptConcurrency': row['observedPeakAttemptConcurrency'],
            'busySecondsAboveCandidateLimit': sum(seconds for count, seconds in row['observedBusySecondsByConcurrency'].items() if count > limit),
            'totalObservedBusySeconds': sum(row['observedBusySecondsByConcurrency'].values()),
        } for row in selected]
    return {'windowStartUtc': dt.datetime.fromtimestamp(start, dt.timezone.utc).isoformat(),
            'windowEndUtc': dt.datetime.fromtimestamp(end, dt.timezone.utc).isoformat(),
            'activeCredentialCount': len(active), 'duplicateIdentities': duplicates,
            'accounts': rows, 'excluded': dict(excluded), 'recommendation': result,
            'pairCandidates': [{'accounts': [r['id'] for r in pair], **recommendation(pair)}
                               for pair in itertools.combinations(rows, 2)] if len(rows) != 2 else [],
            'limitations': ['Completed audit records only; in-flight requests at window end are absent.',
                           'Observed attempt overlap is a lower bound on lease concurrency.',
                           'Failure counts include account attempts that eventually succeeded on another account.',
                           'Card usage counts and fully completed business successes are different metrics.',
                           'Historical throughput reflects offered load, not provider capacity.',
                           'A rounded mean-load estimate can reject normal bursts; validate before rollout.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config-dir', required=True)
    parser.add_argument('--end', help='Timezone-aware ISO timestamp; defaults to current UTC')
    parser.add_argument('--accounts', nargs=2, help='Two sanitized credential IDs from an initial report')
    args = parser.parse_args()
    end = instant(args.end) if args.end else dt.datetime.now(dt.timezone.utc).timestamp()
    if end is None:
        parser.error('--end must contain a timezone')
    start = end - 86400
    root = Path(args.config_dir)
    providers = json.loads((root / 'provider_pools.json').read_text(encoding='utf-8'))[PROVIDER]
    counters = collections.Counter()

    def events():
        for path in audit_files(root / 'request-audit', start, end):
            counters['filesRead'] += 1
            counters['compressedFilesRead'] += int(path.suffix == '.gz')
            counters['archiveFilesRead'] += int(path.parent.name == 'archived-large')
            opener = gzip.open if path.suffix == '.gz' else open
            with opener(path, mode='rt', encoding='utf-8') as handle:
                for line in handle:
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        counters['malformedLines'] += 1

    report = analyze(providers, events(), start, end, args.accounts)
    report['inputDiagnostics'] = dict(counters)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
