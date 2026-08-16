/**
 * Locale dictionaries for the orchestrator pipelines browser.
 * @module @deepseek-ai/dsh-client-ui-orchestrator/client/locales
 */

export const NS = 'orchestratorPipelines' as const

const en = {
  'title': 'Orchestrator pipelines',
  'subtitle': 'Every pipeline across every project, with stage detail and artifacts.',
  'close': 'Close pipelines panel',
  'refresh': 'Refresh',
  'filter.all': 'All',
  'filter.active': 'Active',
  'filter.sealed': 'Sealed',
  'filter.voided': 'Voided',
  'empty': 'No pipelines yet.',
  'hint.select': 'Select a pipeline to inspect its stages and artifacts.',
  'hint.loading': 'Loading…',
  'goalHash': 'Goal hash',
  'goal.unfrozen': 'not frozen yet',
  'vcsBaseline': 'VCS baseline',
  'vcsCandidate': 'Candidate anchor',
  'vcs.none': 'none',
  'attempts': 'rollbacks: {attempts}',
  'candidate': 'Candidate',
  'candidate.none': 'none frozen',
  'approvals': 'Approvals',
  'concessions': 'Concessions',
  'none': 'none',
  'open': 'Pipelines',
  'open.wide': 'Orchestrator pipelines',
} as const

export type OrchestratorPipelinesKey = keyof typeof en

const zh: Record<OrchestratorPipelinesKey, string> = {
  'title': '编排管线',
  'subtitle': '跨项目的全部管线，含阶段详情与工件。',
  'close': '关闭管线面板',
  'refresh': '刷新',
  'filter.all': '全部',
  'filter.active': '进行中',
  'filter.sealed': '已完成',
  'filter.voided': '已作废',
  'empty': '还没有管线。',
  'hint.select': '选择一条管线查看阶段与工件。',
  'hint.loading': '加载中…',
  'goalHash': '目标哈希',
  'goal.unfrozen': '尚未冻结',
  'vcsBaseline': '版本基线',
  'vcsCandidate': 'Candidate 锚',
  'vcs.none': '无',
  'attempts': '回退：{attempts}',
  'candidate': 'Candidate',
  'candidate.none': '未冻结',
  'approvals': '审批',
  'concessions': '让步',
  'none': '无',
  'open': '管线',
  'open.wide': '编排管线',
}

export { en, zh }
