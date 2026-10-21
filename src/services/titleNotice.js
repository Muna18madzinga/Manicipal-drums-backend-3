/**
 * Section 73 notice text. The stage itself is council_ops.title_notice_stage(),
 * so the screen and the action trigger cannot disagree.
 */

const DRAFTERS = ['planner', 'building_inspector', 'eo', 'admin']
const ISSUERS = ['planner', 'eo', 'admin']
const RECORDERS = ['planner', 'eo', 'admin', 'planning_clerk', 'building_inspector']
const ACTORS = ['planner', 'building_inspector', 'eo', 'admin']

function noticeText(row) {
  const action = {
    demolish: 'demolish the building wilfully erected in breach of the condition',
    prohibit_use: 'prohibit the use of the building or land that breaches the condition',
    execute_work: 'carry out the work the condition requires',
  }[row.proposed_action] || row.proposed_action
  const lines = [
    'Vungu Rural District Council',
    'Notice under section 73 of the Rural District Councils Act',
    '',
    `Stand: ${row.stand_number}`,
    `Condition: ${row.condition_text}`,
    `Grounds: ${row.grounds}`,
    `Action proposed: ${action}.`,
  ]
  if (row.proposed_action === 'execute_work' && row.work_description) {
    lines.push(`Work: ${row.work_description}`)
  }
  if (row.condition_class !== 'other') {
    lines.push('You may appeal to the Administrative Court within 28 days of service. The council will not act until that appeal is decided, withdrawn or abandoned.')
  }
  lines.push('This wording is a draft for the council legal officer.')
  return lines.join('\n')
}

module.exports = { DRAFTERS, ISSUERS, RECORDERS, ACTORS, noticeText }
