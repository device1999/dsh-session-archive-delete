/**
 * dsh-session-archive-delete · 备份
 *
 * 把「一个会话」完整复制到它自己的文件夹里，逐文件校验大小与数量，通过后才返回。
 * 目录结构与 delete-archived-sessions.ps1 完全一致，两边可以互相恢复：
 *
 *   <backupRoot>\<id前8位>-<标题>\
 *     sessions\<工作区目录>\session-<完整id>\   会话原始文件（原名）
 *     projcache\session-<完整id>.json           投影缓存（原名）
 *     meta\workspace.json                       删除前的元数据快照
 *     meta\session_projcache.json
 *     manifest.json                             清单
 *     RESTORE.txt / 恢复说明.txt                恢复步骤
 */
import fs from 'node:fs'
import path from 'node:path'
import { listFiles, isInside, uniqueDir } from './paths.js'

/**
 * 按 dateStyle 生成备份文件夹名。
 * dateStyle：
 *   'default'      → 日期+主题          20261020_安装验证 DSH 插件
 *   'id-title'     → ID前8位+主题       a6ccb2ee-安装验证 DSH 插件
 *   'title'        → 纯主题             安装验证 DSH 插件
 *   'id-title-date'→ 前八位+主题+日期    a6ccb2ee-安装验证 DSH 插件_20261020
 * 日期一律紧凑格式 YYYYMMDD；重名由 uniqueDir 加 -2/-3。
 */
export function folderNameByStyle(dateStyle, sessionId, title, now) {
  const d = now instanceof Date ? now : new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const date = '' + y + m + day
  const t = safeTitle(title)
  const id8 = idPrefixOf(sessionId)
  switch (dateStyle) {
    case 'id-title':
      return (id8 ? id8 + '-' : '') + t
    case 'title':
      return t
    case 'id-title-date':
      return (id8 ? id8 + '-' : '') + t + '_' + date
    case 'default':
    default:
      return date + '_' + t
  }
}

// 内部小工具：避免与 paths.js 的命名函数耦合
import { safeFileName as _safeFileName, idPrefix as _idPrefix } from './paths.js'
function safeTitle(title) {
  const s = _safeFileName(title) || '未命名'
  return s
}
function idPrefixOf(sessionId) {
  try {
    return _idPrefix(sessionId)
  } catch {
    return ''
  }
}

/**
 * 比较源目录与备份目录：文件数一致、每个文件大小一致。
 * @returns {string|null} 不一致原因；一致返回 null
 */
export function verifyCopy(srcRoot, dstRoot) {
  const src = listFiles(srcRoot)
  for (const f of src) {
    const rel = path.relative(srcRoot, f)
    const dst = path.join(dstRoot, rel)
    if (!fs.existsSync(dst)) return '备份缺少文件：' + rel
    const a = fs.statSync(f).size
    const b = fs.statSync(dst).size
    if (a !== b) return '备份大小不一致：' + rel
  }
  const dst = listFiles(dstRoot)
  if (dst.length !== src.length) return '备份文件数不一致：源 ' + src.length + '，备份 ' + dst.length
  return null
}

/**
 * 备份一个会话。
 *
 * @param {object} p
 * @param {string} p.backupRoot   备份根目录（必须已解析）
 * @param {string} p.sessionId    完整会话 id
 * @param {string} p.sessionDir   会话目录绝对路径
 * @param {string|null} p.cacheFile 投影缓存文件绝对路径
 * @param {string} p.workspace    工作区目录名（sessions 下的那层）
 * @param {string} p.title        标题
 * @param {object} p.snapshots    { workspaceJson, projcacheJson } 快照源路径
 * @returns {{ok:boolean, dir?:string, name?:string, error?:string}}
 */
export function backupSession(p) {
  const { backupRoot, sessionId, sessionDir, cacheFile, workspace, title, snapshots, extraSessions } = p

  try {
    if (!backupRoot) throw new Error('备份根目录为空')
    fs.mkdirSync(backupRoot, { recursive: true })
    if (!isInside(backupRoot, sessionDir)) {
      // sessionDir 不必在 backupRoot 下，但必须是一个真实存在的会话目录
      if (!fs.existsSync(sessionDir)) throw new Error('会话目录不存在：' + sessionDir)
    }

    const name = folderNameByStyle(p.dateStyle, sessionId, title)
    const dir = uniqueDir(backupRoot, name)

    const sessionsDst = path.join(dir, 'sessions')
    const cacheDst = path.join(dir, 'projcache')
    const metaDst = path.join(dir, 'meta')
    for (const d of [sessionsDst, cacheDst, metaDst]) fs.mkdirSync(d, { recursive: true })

    // 1) 会话目录：原名复制
    const leaf = path.basename(sessionDir)
    const sessTarget = path.join(sessionsDst, workspace, leaf)
    fs.mkdirSync(path.dirname(sessTarget), { recursive: true })
    fs.cpSync(sessionDir, sessTarget, { recursive: true, force: true, errorOnExist: false })
    const problem = verifyCopy(sessionDir, sessTarget)
    if (problem) throw new Error(problem)

    // 2) 投影缓存：原名复制
    let cacheLeaf = null
    if (cacheFile && fs.existsSync(cacheFile)) {
      cacheLeaf = path.basename(cacheFile)
      fs.copyFileSync(cacheFile, path.join(cacheDst, cacheLeaf))
      const a = fs.statSync(cacheFile).size
      const b = fs.statSync(path.join(cacheDst, cacheLeaf)).size
      if (a !== b) throw new Error('缓存备份大小不一致')
    }

    // 3) 元数据快照
    const metaFiles = []
    for (const src of [snapshots && snapshots.workspaceJson, snapshots && snapshots.projcacheJson]) {
      if (src && fs.existsSync(src)) {
        const n = path.basename(src)
        fs.copyFileSync(src, path.join(metaDst, n))
        metaFiles.push(n)
      }
    }

    // 4) 子代理会话：一起备份进同一个文件夹（sessions/<工作区>/<目录名> + projcache）
    const subagents = []
    for (const sub of extraSessions || []) {
      if (!sub || !sub.dir || !fs.existsSync(sub.dir)) continue
      const subLeaf = path.basename(sub.dir)
      const subWs = sub.workspace || workspace
      const subTarget = path.join(sessionsDst, subWs, subLeaf)
      try {
        fs.mkdirSync(path.dirname(subTarget), { recursive: true })
        fs.cpSync(sub.dir, subTarget, { recursive: true, force: true, errorOnExist: false })
        const bad = verifyCopy(sub.dir, subTarget)
        if (bad) throw new Error(bad)
        // 子会话的投影缓存（存在就带上）
        if (sub.cacheFile && fs.existsSync(sub.cacheFile)) {
          fs.copyFileSync(sub.cacheFile, path.join(cacheDst, path.basename(sub.cacheFile)))
        }
        subagents.push({ id: sub.id, workspace: subWs, dirName: subLeaf })
      } catch (err) {
        // 子会话备份失败不阻断主会话，但记录下来
        subagents.push({ id: sub.id, workspace: subWs, dirName: subLeaf, error: String((err && err.message) || err) })
      }
    }

    // 5) 清单
    const fileCount = listFiles(sessTarget).length
    let bytes = 0
    for (const f of listFiles(sessTarget)) bytes += fs.statSync(f).size

    const manifest = {
      schema: 3,
      createdAt: new Date().toISOString(),
      generator: 'dsh-session-archive-delete',
      backupDir: dir,
      layout: 'one folder per session; files keep their original names',
      session: {
        id: sessionId,
        title: title || null,
        workspace,
        source: sessionDir,
        files: fileCount,
        bytes,
        cacheFile: cacheFile || null,
      },
      subagents: subagents.length > 0 ? subagents : undefined,
      metaFiles,
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

    // 6) 恢复说明
    const restore = [
      'DSH 会话备份（单会话）',
      '========================',
      '备份时间：' + new Date().toLocaleString(),
      '会话 id ：' + sessionId,
      '标题    ：' + (title || '（无）'),
      '工作区  ：' + workspace,
      subagents.length > 0 ? '子代理  ：' + subagents.length + ' 个（见下方说明）' : '',
      '',
      '如何恢复',
      '--------',
      '1. 完全退出 DSH。',
      '2. 把 sessions\\' + workspace + '\\' + leaf + ' 复制回 ~/.dsh/sessions/' + workspace + '/',
      '3. 把 projcache\\' + (cacheLeaf || '<缓存文件>') + ' 复制回 ~/.dsh/storages/session_projcache/sessions/',
      '4. 在 ~/.dsh/storages/workspace.json 中把 session id 加回 global.archivedSessionIds',
      '5. 启动 DSH。',
      subagents.length > 0 ? '' : null,
      subagents.length > 0 ? '子代理会话（同样复制回各自的 sessions\\<工作区>\\ 下）：' : null,
      ...subagents.map((s) => '  - sessions\\' + s.workspace + '\\' + s.dirName + (s.error ? '（备份失败：' + s.error + '）' : '')),
      '',
      '注意：恢复前先关闭 DSH，否则它可能用内存里的旧状态覆盖元数据。',
    ]
      .filter((x) => x !== null)
      .join('\r\n')
    fs.writeFileSync(path.join(dir, 'RESTORE.txt'), restore, 'utf8')

    return { ok: true, dir, name: path.basename(dir), subagents }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}
