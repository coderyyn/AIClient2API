import { readFileSync } from 'fs';

describe('usage cache auto refresh source wiring', () => {
  test('server starts configurable usage cache auto refresh service', () => {
    const server = readFileSync('src/services/api-server.js', 'utf8');
    const service = readFileSync('src/services/usage-cache-auto-refresh-service.js', 'utf8');
    const configApi = readFileSync('src/ui-modules/config-api.js', 'utf8');

    expect(server).toContain('startUsageCacheAutoRefreshService');
    expect(service).toContain('USAGE_CACHE_AUTO_REFRESH');
    expect(service).toContain('getAllProvidersUsage');
    expect(service).toContain('writeUsageCache');
    expect(service).toContain('Usage Cache Auto Refresh');
    expect(configApi).toContain('USAGE_CACHE_AUTO_REFRESH');
  });

  test('configuration ui exposes usage cache auto refresh controls', () => {
    const html = readFileSync('static/components/section-config.html', 'utf8');
    const manager = readFileSync('static/app/config-manager.js', 'utf8');

    expect(html).toContain('usageCacheAutoRefreshEnabled');
    expect(html).toContain('usageCacheAutoRefreshStartupRun');
    expect(html).toContain('usageCacheAutoRefreshInterval');
    expect(html).toContain('用量缓存自动刷新');
    expect(manager).toContain('USAGE_CACHE_AUTO_REFRESH');
    expect(manager).toContain('usageCacheAutoRefreshInterval');
  });
});
