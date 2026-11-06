"""Build CellIO.rbxlx (a Roblox place file) from src/ without Rojo.

Mirrors default.project.json:
  src/shared/*.luau          -> ReplicatedStorage.Shared (ModuleScripts)
  src/server/init.server.luau -> ServerScriptService.Server (Script) + sibling modules as children
  src/client/init.client.luau -> StarterPlayer.StarterPlayerScripts.Client (LocalScript) + children
  Players.CharacterAutoLoads = false

Usage: python3 tools/build_rbxlx.py [out=CellIO.rbxlx]
"""
import itertools, pathlib, sys
from xml.sax.saxutils import escape

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'src'
ref = itertools.count(1)

def cdata(text: str) -> str:
    # ']]>' cannot appear inside CDATA; split it if it ever does.
    return '<![CDATA[' + text.replace(']]>', ']]]]><![CDATA[>') + ']]>'

def item(cls: str, name: str, props: str = '', children: str = '') -> str:
    return (f'<Item class="{cls}" referent="RBX{next(ref)}"><Properties>'
            f'<string name="Name">{escape(name)}</string>{props}</Properties>{children}</Item>')

def script(cls: str, name: str, path: pathlib.Path, children: str = '') -> str:
    return item(cls, name, f'<ProtectedString name="Source">{cdata(path.read_text())}</ProtectedString>', children)

def modules(folder: pathlib.Path, skip: str = '') -> str:
    return ''.join(script('ModuleScript', p.stem, p) for p in sorted(folder.glob('*.luau')) if p.name != skip)

def build() -> str:
    shared = item('Folder', 'Shared', children=modules(SRC / 'shared'))
    server = script('Script', 'Server', SRC / 'server' / 'init.server.luau', modules(SRC / 'server', 'init.server.luau'))
    client = script('LocalScript', 'Client', SRC / 'client' / 'init.client.luau', modules(SRC / 'client', 'init.client.luau'))
    body = ''.join([
        item('ReplicatedStorage', 'ReplicatedStorage', children=shared),
        item('ServerScriptService', 'ServerScriptService', children=server),
        item('StarterPlayer', 'StarterPlayer', children=item('StarterPlayerScripts', 'StarterPlayerScripts', children=client)),
        item('Players', 'Players', '<bool name="CharacterAutoLoads">false</bool>'),
    ])
    return ('<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
            'xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">'
            f'<External>null</External><External>nil</External>{body}</roblox>\n')

if __name__ == '__main__':
    out = ROOT / (sys.argv[1] if len(sys.argv) > 1 else 'CellIO.rbxlx')
    out.write_text(build())
    print(f'wrote {out} ({out.stat().st_size // 1024} KB)')
