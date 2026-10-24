// 在新终端（或降级为 tmux / 后台进程）里执行 run.sh。
// 调度器只靠 exit_code 文件判断完成，不依赖终端窗口状态。
import { execFile, spawn, execFileSync } from 'node:child_process';

const SAFE_PATH = /^[A-Za-z0-9_./-]+$/;

function has(bin) {
  try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** 选择启动方式：OPC_LAUNCHER=terminal|tmux|spawn|auto */
export function resolveLauncher(pref = process.env.OPC_LAUNCHER || 'auto') {
  if (pref !== 'auto') return pref;
  if (process.env.CI) return 'spawn';
  if (process.platform === 'darwin') return 'terminal';
  if (process.platform === 'linux' && process.env.DISPLAY && has('gnome-terminal')) return 'terminal';
  if (process.env.TMUX) return 'tmux';
  return 'spawn';
}

function execFileP(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, (err, _out, stderr) => (err ? reject(new Error(`${bin} 失败: ${stderr || err.message}`)) : resolve()));
  });
}

/**
 * @returns {Promise<string>} 实际使用的 launcher
 */
export async function launch(runScript, { launcher, title } = {}) {
  let mode = resolveLauncher(launcher);
  // run.sh 路径会进入 AppleScript 字符串/tmux 命令行。含特殊字符时降级为直接 spawn，
  // 避免拼接注入；spawn 不把路径交给任何 shell 字符串解释。
  if (!SAFE_PATH.test(runScript) && mode !== 'spawn') mode = 'spawn';
  switch (mode) {
    case 'terminal':
      if (process.platform === 'darwin') {
        await execFileP('osascript', ['-e', `tell application "Terminal" to do script "bash ${runScript}"`]);
      } else {
        await execFileP('gnome-terminal', ['--title', title || 'opc', '--', 'bash', runScript]);
      }
      break;
    case 'tmux':
      await execFileP('tmux', ['new-window', '-d', '-n', (title || 'opc').slice(0, 30), 'bash', runScript]);
      break;
    case 'spawn': {
      const child = spawn('bash', [runScript], { detached: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      break;
    }
    default:
      throw Object.assign(new Error(`未知 launcher: ${mode}`), { code: 'LAUNCH_FAILED', retryable: false });
  }
  return mode;
}

/** 超时后终止 run.sh 及其子进程（pi、pi 的 bash 工具子进程） */
export function killRun(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  // spawn 模式下 run.sh 是独立进程组 leader
  try { process.kill(-pid, 'SIGTERM'); } catch { /* 不是组长 */ }
  try { execFileSync('pkill', ['-TERM', '-P', String(pid)], { stdio: 'ignore' }); } catch { /* 无子进程 */ }
  try { execFileSync('sleep', ['0.2'], { stdio: 'ignore' }); } catch { /* ignore */ }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ }
  try { execFileSync('pkill', ['-KILL', '-P', String(pid)], { stdio: 'ignore' }); } catch { /* ignore */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
}
