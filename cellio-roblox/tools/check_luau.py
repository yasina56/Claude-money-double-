"""Static sanity check for the Luau sources (no Luau toolchain needed).

Checks block balance (function/if/for/while/do/repeat vs end/until) after
stripping strings, comments and interpolated strings, and flags a few
non-Luau constructs (!=, ++, +=1 style is fine, `elif`, `null`, `===`).
Usage: python3 tools/check_luau.py src
"""
import re, sys, pathlib

def strip(src: str) -> str:
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if src.startswith('--[[', i) or src.startswith('--[=[', i):
            end = src.find(']]', i)
            i = n if end < 0 else end + 2
            continue
        if src.startswith('--', i):
            j = src.find('\n', i)
            i = n if j < 0 else j
            continue
        if src.startswith('[[', i):
            end = src.find(']]', i)
            out.append('""')
            i = n if end < 0 else end + 2
            continue
        if c in '"\'`':
            q = c
            j = i + 1
            while j < n and src[j] != q:
                if src[j] == '\\':
                    j += 1
                elif q == '`' and src[j] == '{':
                    # interpolated expression: keep it (balanced braces)
                    depth = 1
                    k = j + 1
                    while k < n and depth:
                        depth += {'{': 1, '}': -1}.get(src[k], 0)
                        k += 1
                    out.append(' ' + src[j + 1:k - 1] + ' ')
                    j = k - 1
                j += 1
            out.append('""')
            i = j + 1
            continue
        out.append(c)
        i += 1
    return ''.join(out)

OPEN = {'function', 'do', 'repeat', 'then'}
def check(path: pathlib.Path) -> list[str]:
    errs = []
    code = strip(path.read_text())
    # `if ... then` opens a block only when it is a statement, not an if-expression.
    # Treat `then` as opening a block only when the line's statement starts with if/elseif.
    depth = 0
    stack = []
    for lineno, line in enumerate(code.split('\n'), 1):
        toks = re.findall(r'[A-Za-z_][A-Za-z0-9_]*|!=|===|\+\+|[^\sA-Za-z0-9_]', line)
        for k, t in enumerate(toks):
            if t in ('!=', '===', '++'):
                errs.append(f'{path}:{lineno}: non-Luau operator {t!r}')
            if t in ('elif', 'null', 'undefined'):
                errs.append(f'{path}:{lineno}: suspicious token {t!r}')
        stmt = line.strip()
        # block openers
        for t in re.findall(r'\b(function|do|repeat|end|until|then|if|elseif)\b', line):
            if t in ('function', 'repeat'):
                stack.append((t, lineno))
            elif t == 'do':
                stack.append((t, lineno))
            elif t == 'then':
                pass
            elif t == 'if':
                # statement if (block) vs expression if (no end): statement ifs start the line
                pass
            elif t == 'end':
                if not stack:
                    errs.append(f'{path}:{lineno}: unexpected end')
                else:
                    stack.pop()
            elif t == 'until':
                if not stack or stack[-1][0] != 'repeat':
                    errs.append(f'{path}:{lineno}: until without repeat')
                else:
                    stack.pop()
        if re.match(r'^(if)\b', stmt) and re.search(r'\bthen\b', stmt):
            stack.append(('if', lineno))
        elif re.match(r'^(if)\b', stmt):
            # multi-line `if` statement condition: opens a block too
            stack.append(('if', lineno))
    for t, ln in stack:
        errs.append(f'{path}:{ln}: unclosed {t}')
    return errs

def main():
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'src')
    files = sorted(root.rglob('*.luau'))
    errs = []
    for f in files:
        errs += check(f)
    for e in errs:
        print(e)
    print(f'{len(files)} files checked, {len(errs)} problems')
    sys.exit(1 if errs else 0)

if __name__ == '__main__':
    main()
