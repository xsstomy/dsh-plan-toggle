/**
 * dsh-plan-toggle 浏览器半（单文件，经 __ModuleLoader__ 加载：官方 Web 没有任何
 * 快捷键注册机制，因此这里自己在 window 捕获阶段挂 keydown）。
 *
 * 键位：Alt+1 → /plan-toggle（进/出 plan 模式）；Alt+2 → /plan-review（复核流水线）。
 *   - 用 event.code（Digit1/Digit2）判定，规避 macOS 上 Option+1/2 产出 ¡/™ 的问题；
 *   - altKey 是判定核心；Cmd+1..9 是浏览器保留键，Alt+数字不是；
 *   - 捕获阶段 + preventDefault：输入框内也生效（用户随时能按）。
 *
 * 只做"键 → 命令"的转发，不含任何流程逻辑：命令的 host 端就在 lib/index.js，
 * 这样状态机永远只有一份（不会出现浏览器与 host 各记一套状态）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plan-toggle',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // 键位表：event.code → 命令名。v1 硬编码（改键列为后续项）。
    var COMBO = { Digit1: '/plan-toggle', Digit2: '/plan-review' }

    function resolveLine(event) {
      if (event.altKey !== true || event.repeat === true) return null
      // 与 Ctrl/Cmd 组合区分开：只认"纯 Alt+数字"，避免与系统/应用快捷键抢键。
      if (event.ctrlKey === true || event.metaKey === true) return null
      return COMBO[event.code] ?? null
    }

    function currentSessionId(ctx) {
      var sessions = ctx.get('sessions')
      var list = sessions === undefined ? undefined : sessions.list
      if (list === undefined || typeof list.getSnapshot !== 'function') return undefined
      return list.getSnapshot().current
    }
    function apply(ctx) {
      var handler = function (event) {
        var line = resolveLine(event)
        if (line === null) return
        var sessionId = currentSessionId(ctx)
        if (typeof sessionId !== 'string' || sessionId === '') return // 没有当前会话：静默忽略，不抢键
        var remote = ctx.get('remote')
        var commands = remote === undefined ? undefined : remote.commands
        if (commands === undefined || typeof commands.execute !== 'function') return
        event.preventDefault()
        event.stopPropagation()
        Promise.resolve(commands.execute(sessionId, line, [])).catch(function (error) {
          console.error('[dsh-plan-toggle] command failed', error)
        })
      }
      ctx.effect(function () {
        window.addEventListener('keydown', handler, true)
        return function () {
          window.removeEventListener('keydown', handler, true)
        }
      }, 'dsh-plan-toggle: keys')
    }

    exports.apply = apply
    exports.inject = ['sessions', 'remote', 'remote.commands']
    return module.exports
  },
})
