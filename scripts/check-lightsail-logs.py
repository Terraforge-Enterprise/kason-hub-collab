import sys, json

try:
    d = json.load(sys.stdin)
    events = d.get('logEvents', [])
    print(f'{len(events)} events received')
    error_lines = []
    for e in events:
        msg = e.get('message', '')
        low = msg.lower()
        if 'prismaclient' in low or 'invalid' in low or 'error' in low or '500' in low or 'exception' in low or 'unhandled' in low:
            error_lines.append(msg)
    for m in error_lines[-15:]:
        print('---')
        print(m[:600])
    if not error_lines:
        print('(no error-keyword lines found in window)')
except Exception as ex:
    print(f'parse-err: {ex}')
