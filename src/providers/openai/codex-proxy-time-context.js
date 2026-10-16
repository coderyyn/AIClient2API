const BLOCK = /^\s*<(environment_context|codex_apps_client_time_context|proxy_time_context)>([\s\S]*?)<\/\1>\s*$/;

function zonedParts(now, timezone) {
    return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(now).map(part => [part.type, part.value]));
}

/** Only standalone, recognized machine context blocks are eligible; never search arbitrary prose. */
export function rewriteProxyTimeContext(original, timezone, now = new Date()) {
    const body = { ...original, input: structuredClone(original.input) };
    const parts = zonedParts(now, timezone);
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const context = `<proxy_time_context>\n<timezone>${timezone}</timezone>\n<current_date>${date}</current_date>\n</proxy_time_context>`;
    if (typeof body.input === 'string') body.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }];
    if (!Array.isArray(body.input)) body.input = [];
    const latest = new Map();
    for (const item of body.input) {
        if (!['user', 'developer', 'system'].includes(item?.role)) continue;
        const values = typeof item.content === 'string' ? [{ item, text: item.content }] :
            (Array.isArray(item.content) ? item.content.filter(p => p?.type === 'input_text' || p?.type === 'text').map(p => ({ part: p, text: p.text })) : []);
        for (const value of values) {
            const match = typeof value.text === 'string' && value.text.match(BLOCK);
            if (match) latest.set(match[1], value);
        }
    }
    let action = 'added';
    for (const [kind, value] of latest) {
        let text = value.text;
        if (kind === 'proxy_time_context') text = context;
        else {
            const closing = `</${kind}>`;
            text = /<timezone>[^<]*<\/timezone>/.test(text)
                ? text.replace(/<timezone>[^<]*<\/timezone>/, `<timezone>${timezone}</timezone>`)
                : text.replace(closing, `<timezone>${timezone}</timezone>\n${closing}`);
            text = /<current_date>[^<]*<\/current_date>/.test(text)
                ? text.replace(/<current_date>[^<]*<\/current_date>/, `<current_date>${date}</current_date>`)
                : text.replace(closing, `<current_date>${date}</current_date>\n${closing}`);
        }
        if (value.item) value.item.content = text;
        else value.part.text = text;
        action = 'replaced';
    }
    if (!latest.size) body.input.unshift({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: context }] });
    for (const key of ['timezone', 'time_zone', 'timeZone']) if (Object.hasOwn(body, key)) body[key] = timezone;
    if (Object.hasOwn(body, 'timezone_offset_min')) {
        const wallClock = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
        body.timezone_offset_min = Math.round((Math.floor(now.getTime() / 1000) * 1000 - wallClock) / 60000);
    }
    return { body, audit: { action, timezone, date } };
}
