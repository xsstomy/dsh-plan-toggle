/**
 * 归档 IO 层：把复核后的计划写进 `<会话 cwd>/docs/plans/YYYY-MM-DD-功能名.md`。
 *
 * 为什么用 node:fs 而不是 ctx.get('fs')：这里只需要"在已知工作目录里写一个 md"，
 * 走官方 fs 服务会额外耦合 fs-sandbox 的 workspace/策略状态，而归档路径本身由插件
 * 决定（不交给模型），没有复用到策略的价值。写不进去就报错，不静默降级。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  archiveCandidateNames,
  chooseArchiveName,
  pickArchiveSlug,
  pickArchiveTitle,
} from './state.js'

/** 读已存在文件的全文；不存在返回 undefined（其它错误照抛）。 */
async function readIfExists(absolutePath) {
  try {
    return await readFile(absolutePath, 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return undefined
    throw error
  }
}

/** 取文件首行标题（用于判断是否同一份计划）。 */
export function firstTitleOf(content) {
  const firstLine = String(content ?? '').split('\n').find(line => line.trim() !== '') ?? ''
  return firstLine.replace(/^#+\s*/, '').trim()
}

/**
 * 归档计划：命名与冲突规则见 chooseArchiveName（同标题原地更新，同名不同计划不覆盖）。
 * @param input.cwd - 会话工作目录（归档根）。
 * @param input.planText - 复核后修订的完整计划 markdown。
 * @param input.dateStr - 本地日期 `YYYY-MM-DD`。
 * @returns 归档结果 `{path, mode}`，mode 为 `create` 或 `update`。
 * @throws 候选名耗尽（同名不同计划的归档过多）或 IO 失败时。
 */
export async function archivePlan({ cwd, planText, dateStr }) {
  const directory = join(cwd, 'docs', 'plans')
  const title = pickArchiveTitle(planText)
  const names = archiveCandidateNames(dateStr, pickArchiveSlug(planText))
  const candidates = []
  for (const name of names) {
    const absolutePath = join(directory, name)
    const existing = await readIfExists(absolutePath)
    candidates.push({
      name,
      exists: existing !== undefined,
      firstTitle: existing === undefined ? '' : firstTitleOf(existing),
    })
  }
  const chosen = chooseArchiveName({ candidates, planTitle: title })
  if (chosen === undefined) {
    throw new Error(`同名归档候选耗尽（${names.length} 个），请手工整理 ${directory}`)
  }
  const absolutePath = join(directory, chosen.name)
  await mkdir(directory, { recursive: true })
  await writeFile(absolutePath, planText.endsWith('\n') ? planText : `${planText}\n`, 'utf8')
  return { path: absolutePath, mode: chosen.mode }
}
