import { planItem } from './plan.js'

// Starting points for a coach's plan. Picking one fills the editor as unsaved rows, so the
// coach adjusts them to the patient before saving. Days: 0 is Monday.
const TEMPLATES = [
  {
    id:'upper-body-starter',
    name:'Upper body starter',
    description:'Arms and shoulders, 4 days a week, light weights.',
    rows:[
      { name:'Bicep curl', exercise:'bicep-curl', sets:3, reps:10, days:[0, 2, 4], rest:60, notes:'Light weight. Slow on the way down.' },
      { name:'Lateral raise', exercise:'lateral-raise', sets:2, reps:10, days:[0, 2, 4], rest:60, notes:'Stop at shoulder height.' },
      { name:'Shoulder press', exercise:'shoulder-press', sets:2, reps:8, days:[1, 3], rest:90, notes:'' },
      { name:'Dumbbell row', exercise:'dumbbell-row', sets:3, reps:10, days:[1, 3], rest:60, notes:'Support yourself on a bench or chair.' },
    ],
  },
  {
    id:'knee-hip-rehab',
    name:'Knee and hip rehab',
    description:'Leg strength and a daily walk, building up over the week.',
    rows:[
      { name:'Seated leg raise', exercise:'seated-leg-raise', sets:2, reps:12, days:[0, 1, 2, 3, 4], rest:45, notes:'Hold the top for a second.' },
      { name:'Squat', exercise:'squat', sets:3, reps:8, days:[0, 2, 4], rest:90, notes:'Only as deep as is comfortable. Hold a chair if needed.' },
      { name:'Goblet squat', exercise:'goblet-squat', sets:2, reps:8, days:[5], rest:90, notes:'Skip if the knee is sore.' },
      { name:'Walk', exercise:null, sets:1, reps:20, perWeek:5, rest:0, notes:'Minutes, at an easy pace, any 5 days.' },
    ],
  },
  {
    id:'gentle-shoulder',
    name:'Gentle shoulder',
    description:'Low-load shoulder work, every other day.',
    rows:[
      { name:'Scaption', exercise:'scaption', sets:2, reps:10, days:[0, 2, 4, 6], rest:60, notes:'Thumbs up, arms slightly forward.' },
      { name:'Lateral raise', exercise:'lateral-raise', sets:2, reps:8, days:[0, 2, 4, 6], rest:60, notes:'No higher than shoulder height.' },
      { name:'Bicep curl', exercise:'bicep-curl', sets:2, reps:12, perWeek:2, rest:45, notes:'Any 2 days.' },
    ],
  },
]

// Each row goes through the same checks as a saved row, so a template can never hold one
// the server would refuse.
export const planTemplates = TEMPLATES.map(template => ({
  ...template,
  items:template.rows.map(row => {
    const result = planItem({ ...row, sets:String(row.sets), reps:String(row.reps), perWeek:String(row.perWeek ?? row.days.length), rest:String(row.rest) })
    if (result.error) throw new Error(`Plan template ${template.id}: ${result.error}`)
    return result.item
  }),
}))
