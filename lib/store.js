/**
 * dsh-session-archive-delete · 设置持久化
 *
 * 存到 ~/.dsh/dsh-session-archive-delete.json（不写进 profile，不污染插件目录）。
 * 读取失败一律回落到默认值；写入用「临时文件 + 改名」，避免半截 JSON。
 *
 * 设置项：
 *   mode         'backup-then-delete'（默认）| 'delete-only'
 *   backupRoot   备份根目录；空字符串 = <工作区根目录>\DSH-归档会话
 *   confirm      是否弹确认框（默认 true）
 */
import fs from 'node:fs'
import path from 'node:path'
import { dshHome } from './paths.js'

export const DEFAULTS = Object.freeze({
  mode: 'both', // 'both'（同时显示两个菜单项，默认）| 'backup-then-delete' | 'delete-only'
  backupRoot: '',
  confirm: true,
  dateStyle: 'default', // 'default'（日期+主题）| 'id-title' | 'title' | 'id-title-date'
})

let cache = null

export function settingsFile() {
  return path.join(dshHome(), 'dsh-session-archive-delete.json')
}

/** 读设置（带内存缓存，写入后失效） */
export function readSettings() {
  if (cache) return { ...cache }
  let loaded = {}
  try {
    loaded = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}
  } catch {
    loaded = {}
  }
  cache = normalize(loaded)
  return { ...cache }
}

/** 全量覆盖写设置，返回写入后的值 */
export function writeSettings(patch) {
  const next = normalize({ ...readSettings(), ...(patch || {}) })
  const file = settingsFile()
  const tmp = file + '.tmp'
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {}
    throw new Error('settings write failed: ' + String((err && err.message) || err))
  }
  cache = next
  return { ...next }
}

/** 备份文件夹命名方式（dateStyle）合法值与默认 */
const DATE_STYLES = ['default', 'id-title', 'title', 'id-title-date']

/** 把任意输入收敛成合法设置。mode 默认 both：菜单同时显示两个选项 */
export function normalize(input) {
  const src = input && typeof input === 'object' ? input : {}
  const mode = src.mode === 'delete-only' || src.mode === 'backup-then-delete' ? src.mode : 'both'
  const backupRoot = typeof src.backupRoot === 'string' ? src.backupRoot.trim() : ''
  const confirm = src.confirm === false ? false : true
  const dateStyle = DATE_STYLES.indexOf(src.dateStyle) >= 0 ? src.dateStyle : 'default'
  return { mode, backupRoot, confirm, dateStyle }
}

/** 测试或热更新后清掉缓存 */
export function resetCache() {
  cache = null
}
