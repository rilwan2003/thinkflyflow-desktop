"""Prove the search endpoint returns real hits for a freshly uploaded file."""
import json
import os
import urllib.parse
import urllib.request
import uuid

BASE = 'http://127.0.0.1:8001'
KEY = os.environ['API_KEY']
PROJECT = '7e453aa7-e7b6-48a1-920d-be8620d291cb'


def req(method, path, data=None, headers=None):
    h = {'Accept': 'application/json', 'Authorization': 'Bearer ' + KEY}
    if headers:
        h.update(headers)
    r = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    with urllib.request.urlopen(r, timeout=90) as x:
        return json.loads(x.read().decode() or '{}')


marker = 'zephyr' + uuid.uuid4().hex[:6]
payload = ('quarterly ' + marker + ' report body').encode()
b = '----t' + uuid.uuid4().hex
body = (
    f'--{b}\r\nContent-Disposition: form-data; name="project_id"\r\n\r\n{PROJECT}\r\n'.encode()
    + f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="{marker}.txt"\r\n'
    f'Content-Type: text/plain\r\n\r\n'.encode()
    + payload
    + b'\r\n'
    + f'--{b}--\r\n'.encode()
)

up = req('POST', '/api/v2/files/upload/', body,
         {'Content-Type': f'multipart/form-data; boundary={b}'})
fid = (up.get('data') or {}).get('id')
print('uploaded:', fid, 'name:', marker + '.txt')
assert fid, up

# A fresh upload starts as 'uploading' and only becomes searchable when the
# AI pass finishes (the endpoint filters status='ready'). Poll briefly, which
# also documents that behaviour for anyone reading this.
import time
res = {}
deadline = time.time() + 60
while time.time() < deadline:
    res = req('GET', '/api/v2/search/?q=' + urllib.parse.quote(marker))
    files_now = ((res.get('data') or {}).get('files')) or []
    if files_now:
        break
    time.sleep(3)
files = ((res.get('data') or {}).get('files')) or []
print('search hits:', len(files))
for f in files[:3]:
    print('  -', f.get('name'), '| matched_on =', f.get('matched_on'), '|', f.get('project_name'))

ok = any(f.get('name') == marker + '.txt' for f in files)

# Clean up so the test leaves no data behind.
if fid:
    d = req('DELETE', f'/api/v2/files/{fid}/')
    print('cleanup ok:', bool(d.get('success')), '|', d.get('message', ''))

print('FOUND UPLOADED FILE:', ok)
print('RESULT:', 'PASS' if ok else 'FAIL')
raise SystemExit(0 if ok else 1)
