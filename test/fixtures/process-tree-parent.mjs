import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const grandchild = spawn(process.execPath, ['-e',
  "setInterval(() => require('node:fs').appendFileSync(process.env.GALATEA_HEARTBEAT_FILE, 'x'), 50)"], {
  env: process.env, stdio: 'ignore', windowsHide: true,
})
writeFileSync(process.env.GALATEA_GRANDCHILD_PID_FILE, String(grandchild.pid))
setInterval(() => {}, 1000)
