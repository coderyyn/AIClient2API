"""Render hardened ingress from the existing per-entry allowlists; never install it."""
import argparse
from pathlib import Path
import re


def render(source, output):
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    names = [('aiclient2api-public-3000.conf', 'port'), ('beeintel-3000.conf', 'domain')]
    names = [(name, kind) for name, kind in names if (source / name).exists()]
    assert any(kind == 'domain' for _, kind in names), 'missing domain ingress'
    geos = []
    for name, kind in names:
        text = (source / name).read_text()
        assert 'aiclient_entry_admin' not in text, 'ingress already hardened'
        blocks = text.split('server {')
        lists = []
        for block in blocks[1:]:
            root = re.search(r'location = / \{(.*?)\n\s*\}', block, re.S)
            assert root, 'missing existing management allowlist'
            addresses = re.findall(r'\ballow\s+([^;]+);', root[1])
            assert addresses and 'all' not in addresses
            lists.append(addresses)
        assert lists and all(x == lists[0] for x in lists), 'entry lists diverge; refusing to merge privileges'
        geos.append('geo $aiclient_' + kind + '_admin {\n    default 0;\n' + ''.join('    ' + ip + ' 1;\n' for ip in lists[0]) + '}\n')
        gate = ('server {\n    set $aiclient_entry_admin $aiclient_' + kind + '_admin;\n'
                '    if ($aiclient_plugin_install_blocked) { return 403; }\n'
                '    if ($aiclient_entry_denied) { return 403; }\n'
                '    location = /app/base.css {\n'
                '        include /etc/nginx/snippets/aiclient2api-proxy-common.conf;\n    }\n')
        (output / name).write_text(text.replace('server {', gate))
    policy = r'''
map "$request_method:$uri" $aiclient_public_request {
    default 0;
    ~^(GET|HEAD):/(health|potluck-user\.html|app/base\.css|favicon\.ico)/?$ 1;
    ~^(GET|OPTIONS):/api/potluckuser/usage/?$ 1;
    ~^(GET|POST|HEAD|OPTIONS):/(?:(?!(?:api|runtime|master|static|app|components)/)[^/]+/)?v1/(?:chat/completions|responses|messages(?:/count_tokens)?|models|images/(?:generations|edits))/?$ 1;
    ~^(GET|POST|HEAD|OPTIONS):/(?:(?!(?:api|runtime|master|static|app|components)/)[^/]+/)?v1beta/models(?:/[^/]+(?::[^/]+)?)?/?$ 1;
    # Only the existing internal location can serve this subrequest.
    ~^GET:/_edge_auth$ 1;
}
map $uri $aiclient_plugin_install_blocked {
    default 0;
    ~^/api/plugins/(upload|install)/?$ 1;
}
map "$aiclient_entry_admin:$aiclient_public_request" $aiclient_entry_denied {
    default 0;
    "0:0" 1;
}
'''
    (output / '00-aiclient-management-policy.conf').write_text('\n'.join(geos) + policy)
    return {kind: len(re.findall(r' 1;', geo)) for (_, kind), geo in zip(names, geos)}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, default=Path('/etc/nginx/conf.d'))
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    print(render(args.source, args.output))
