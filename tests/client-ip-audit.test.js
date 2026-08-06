import { getClientIp } from '../src/utils/common.js';

describe('trusted proxy client ip audit contract', () => {
  test('prefers x-real-ip from a trusted peer and exposes the source details', () => {
    const req = {
      headers: { 'x-real-ip': '119.123.77.234', 'x-forwarded-for': '198.51.100.9' },
      socket: { remoteAddress: '172.17.0.1' }
    };
    expect(getClientIp(req, {
      TRUST_PROXY: true,
      TRUSTED_PROXY_IPS: ['172.17.0.1']
    }, { detailed: true })).toEqual({
      clientIp: '119.123.77.234',
      peerIp: '172.17.0.1',
      clientIpSource: 'trusted-x-real-ip'
    });
  });

  test('audit detail mode trusts an explicitly listed peer without weakening legacy auth ip behavior', () => {
    const req = {
      headers: { 'x-real-ip': '119.123.77.234' },
      socket: { remoteAddress: '172.17.0.1' }
    };
    const config = {
      TRUST_PROXY: false,
      TRUSTED_PROXY_IPS: ['172.17.0.1']
    };

    expect(getClientIp(req, config)).toBe('172.17.0.1');
    expect(getClientIp(req, config, { detailed: true })).toMatchObject({
      clientIp: '119.123.77.234',
      clientIpSource: 'trusted-x-real-ip'
    });
  });

  test('falls back to x-forwarded-for only when trusted x-real-ip is absent', () => {
    const req = {
      headers: { 'x-forwarded-for': '198.51.100.9, 172.17.0.1' },
      socket: { remoteAddress: '172.17.0.1' }
    };
    expect(getClientIp(req, {
      TRUST_PROXY: true,
      TRUSTED_PROXY_IPS: ['172.17.0.1']
    }, { detailed: true })).toMatchObject({
      clientIp: '198.51.100.9',
      clientIpSource: 'trusted-x-forwarded-for'
    });
  });

  test('rejects malformed forwarding values and uses the next valid trusted header', () => {
    const req = {
      headers: { 'x-real-ip': 'not-an-ip', 'x-forwarded-for': '198.51.100.9, 172.17.0.1' },
      socket: { remoteAddress: '172.17.0.1' }
    };
    expect(getClientIp(req, {
      TRUSTED_PROXY_IPS: ['172.17.0.1']
    }, { detailed: true })).toMatchObject({
      clientIp: '198.51.100.9',
      clientIpSource: 'trusted-x-forwarded-for'
    });
  });

  test('ignores forwarding headers from an untrusted peer', () => {
    const req = {
      headers: { 'x-real-ip': '119.123.77.234', 'x-forwarded-for': '198.51.100.9' },
      socket: { remoteAddress: '203.0.113.7' }
    };
    expect(getClientIp(req, {
      TRUST_PROXY: true,
      TRUSTED_PROXY_IPS: ['172.17.0.1']
    }, { detailed: true })).toEqual({
      clientIp: '203.0.113.7',
      peerIp: '203.0.113.7',
      clientIpSource: 'peer'
    });
  });
});
