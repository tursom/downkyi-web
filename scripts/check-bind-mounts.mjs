import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const docker = args => execFileSync('docker', args, { cwd, encoding: 'utf8' }).trim();
const config = JSON.parse(docker(['compose', 'config', '--format', 'json']));
assert.equal(Object.keys(config.volumes || {}).length, 0, 'Named volumes are not allowed');
const service = config.services.downloader;
assert.equal(service.volumes.length, 3);
for (const mount of service.volumes) {
  assert.equal(mount.type, 'bind');
  assert.equal(mount.bind.create_host_path, false);
}
const exported = service.volumes.find(mount => mount.target === '/export');
assert.equal(exported.source, '/export');
assert.notEqual(exported.read_only, true);
assert.equal(service.environment.DOWNKYI_DATA_DIR, '/data');

const image = process.env.DOWNKYI_CHECK_IMAGE || 'downkyi-web:local';
const name = `downkyi-bind-check-${process.pid}`;
const args = ['create', '--name', name, '--network', 'none', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true'];
for (const mount of service.volumes) {
  args.push('--mount', `type=bind,source=${mount.source},target=${mount.target}`);
}
args.push('--entrypoint', 'python', image, '-c', `
import json, os, uuid
from pathlib import Path
assert os.getuid() == 1000
assert Path('/export').is_dir()
assert os.access('/export', os.R_OK | os.X_OK)
for root in ('/data', '/downloads'):
    path = Path(root) / ('.bind-check-' + uuid.uuid4().hex)
    try:
        with path.open('x') as file:
            file.write('bind-check')
        assert path.read_text() == 'bind-check'
    finally:
        path.unlink(missing_ok=True)
print(json.dumps({'uid':os.getuid(), 'export_visible':True, 'local_bind_writes':True}))
`);
let created = false;
try {
  docker(args);
  created = true;
  const inspect = JSON.parse(docker(['inspect', name]))[0];
  assert.equal(inspect.Mounts.length, 3);
  assert.ok(inspect.Mounts.every(mount => mount.Type === 'bind'));
  console.log(JSON.stringify({mounts: inspect.Mounts.map(mount => ({type:mount.Type,source:mount.Source,target:mount.Destination,rw:mount.RW}))}, null, 2));
  console.log(docker(['start', '--attach', name]));
  assert.equal(JSON.parse(docker(['inspect', name]))[0].State.ExitCode, 0);
} finally {
  if (created) docker(['rm', '--force', name]);
}
