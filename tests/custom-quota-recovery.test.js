import { applyProviderRateLimitCooldown } from '../src/utils/common.js';
import { jest, test, expect } from '@jest/globals';
for (const code of ['credit_balance_exhausted','usage_limit_reached','insufficient_quota']) {
 test(`${code} without explicit reset does not invent monthly recovery`,()=>{
  const manager={markProviderUnhealthyWithRecoveryTime:jest.fn(),markQuotaExhaustedUntilReset:jest.fn()};
  const error={response:{status:429,data:{error:{code}}}};
  expect(applyProviderRateLimitCooldown({error,providerPoolManager:manager,providerType:'openaiResponses-custom',providerUuid:'key'})).toBe(true);
  expect(manager.markProviderUnhealthyWithRecoveryTime.mock.calls[0][3]).toBeNull();
  expect(manager.markQuotaExhaustedUntilReset).not.toHaveBeenCalled();
 });
}
test('explicit reset is honored even when generic cooldown is disabled',()=>{
 const manager={markProviderUnhealthyWithRecoveryTime:jest.fn()};const before=Date.now();
 applyProviderRateLimitCooldown({error:{response:{status:429,headers:{'retry-after':'30'},data:{error:{code:'usage_limit_reached'}}}},providerPoolManager:manager,providerType:'openaiResponses-custom',providerUuid:'key'});
 expect(+manager.markProviderUnhealthyWithRecoveryTime.mock.calls[0][3]).toBeGreaterThanOrEqual(before+30000);
});
