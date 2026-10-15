import fs from 'fs';
import vm from 'vm';

function dispatchContext() {
    const source = fs.readFileSync('static/app/modal.js', 'utf8');
    const operations = ['toggleProviderStatus','editProvider','cancelEdit','saveProvider','performSingleHealthCheck',
        'refreshProviderToken','reauthorizeProvider','refreshProviderUuid','deleteProvider',
        'resetAllProvidersHealth','performHealthCheck','refreshUnhealthyUuids','deleteUnhealthyProviders'];
    const buttons = [{ disabled: false }, { disabled: false }];
    const group = { querySelectorAll: () => buttons, setAttribute: jest.fn(), removeAttribute: jest.fn() };
    const row = { querySelector: () => group };
    const context = { window: {}, currentProviderType: 'openai-codex-oauth',
        closeProviderMenus: jest.fn(), toggleProviderMenu: jest.fn(), mutateProviderArchive: jest.fn(), showToast: jest.fn() };
    operations.forEach(name => context[name] = jest.fn());
    vm.runInNewContext(source.slice(source.indexOf('const providerActionLocks = new Set();')), context);
    const event = { preventDefault: jest.fn(), stopPropagation: jest.fn(), target: { closest: selector => selector === '[data-uuid]' ? row : {} } };
    return { context, event, buttons };
}

test('in-flight account actions reject duplicate clicks and restore controls after completion', async () => {
    const { context, event, buttons } = dispatchContext();
    let finish;
    context.refreshProviderToken.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = context.runProviderAction('refreshProviderToken', 'account', event);
    expect(buttons.every(button => button.disabled)).toBe(true);
    await context.runProviderAction('refreshProviderToken', 'account', event);
    expect(context.refreshProviderToken).toHaveBeenCalledTimes(1);
    finish(); await pending;
    expect(buttons.every(button => !button.disabled)).toBe(true);
    context.refreshProviderToken.mockResolvedValueOnce();
    await context.runProviderAction('refreshProviderToken', 'different-account', event);
}, 1000);

test('action failures restore controls and allow retry', async () => {
    const { context, event, buttons } = dispatchContext();
    context.mutateProviderArchive.mockRejectedValueOnce(new Error('绑定冲突')).mockResolvedValueOnce();
    await context.runProviderAction('archive', 'account', event);
    expect(context.showToast).toHaveBeenCalledWith('操作失败', '绑定冲突', 'error');
    expect(buttons.every(button => !button.disabled)).toBe(true);
    await context.runProviderAction('archive', 'account', event);
    expect(context.mutateProviderArchive).toHaveBeenCalledTimes(2);
    expect(context.mutateProviderArchive).toHaveBeenLastCalledWith(['account'], 'archive');
});
