/**
 * dsh-session-archive-delete · 路径与命名工具
 *
 * 三个原则，与 delete-archived-sessions.ps1 保持一致：
 *   1. 会话目录名原样保留（session-<uuid>），备份里不改名，恢复时直接复制回去
 *   2. 备份文件夹名 <id 前 8 位>-<标题>，重名加 -2 / -3
 *   3. 任何写操作前先确认目标路径确实在预期根目录之下，绝不越界
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** DSH 家目录：与宿主其它插件一致，优先 DSH_HOME，其次 ~/.dsh */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * 标题转安全文件名：去掉 Windows 非法与易混淆字符，压缩空白，按字节裁剪。
 * 默认 60 字节（约 20 个汉字），与 ps1 一致。
 */
export function safeFileName(text, maxBytes = 60) {
  if (!text) return ''
  let s = String(text)
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/[\[\]{}#%&~`^$@+=;,!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-_. ]+|[-_. ]+$/g, '')
  const buf = Buffer.from(s, 'utf8')
  if (buf.length > maxBytes) {
    let cut = maxBytes
    while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--
    s = buf.subarray(0, cut).toString('utf8').replace(/^[-_. ]+|[-_. ]+$/g, '')
  }
  return s
}

/** session UUID 前 8 位小写 */
export function idPrefix(sessionId) {
  const leaf = String(sessionId || '').replace(/^session-/, '')
  const m = leaf.match(/^([0-9a-fA-F]{8})/)
  if (m) return m[1].toLowerCase()
  return (safeFileName(leaf, 8) || 'unknown').toLowerCase()
}

/** 备份文件夹名：<前8位>-<标题> */
export function backupName(sessionId, title) {
  const t = safeFileName(title) || '未命名'
  return idPrefix(sessionId) + '-' + t
}

/**
 * 在 root 下为 name 找一个不冲突的目录名（已存在就 -2 / -3）。
 * @returns {string} 绝对路径
 */
export function uniqueDir(root, name) {
  let candidate = name
  let n = 2
  while (fs.existsSync(path.join(root, candidate))) {
    candidate = name + '-' + n
    n++
  }
  return path.join(root, candidate)
}

/** 确认 child 解析后确实在 parent 之下（防止路径穿越与大小写/短名绕行） */
export function isInside(parent, child) {
  const p = path.resolve(parent)
  const c = path.resolve(child)
  if (c === p) return false
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)
}

/** 递归列出目录下所有文件（返回绝对路径数组） */
export function listFiles(root) {
  const out = []
  const walk = (dir) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) out.push(full)
    }
  }
  walk(root)
  return out
}

/** 递归计算目录大小（字节） */
export function dirSize(root) {
  let total = 0
  for (const f of listFiles(root)) {
    try {
      total += fs.statSync(f).size
    } catch {}
  }
  return total
}
