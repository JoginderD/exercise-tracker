// Exercise-specific prototype values. These are not clinical safety limits.
// Add profiles with their own landmarks, metrics, repetition phases and form rules.
export const curl = {
  id: 'bicep-curl',
  name: 'Bicep curl',
  instructions: 'Stand side-on with your selected shoulder, elbow, wrist and hip visible.',
  landmarks: {
    left: { shoulder:11, elbow:13, wrist:15, hip:23 },
    right: { shoulder:12, elbow:14, wrist:16, hip:24 },
  },
  metrics: {
    elbow: ['shoulder','elbow','wrist'],
    upperArm: ['elbow','shoulder','hip'],
  },
  connections: [['shoulder','elbow'],['elbow','wrist'],['shoulder','hip']],
  minVisibility: 0.7,
  maxGapMs: 500,
  rep: { metric:'elbow', start:150, target:70, direction:'decreasing', holdMs:150 },
  formRules: [{
    id:'raised-elbow', metric:'upperArm', max:30, clearBelow:25, holdMs:300,
    message:'Upper arm raised: keep your elbow closer to your side.',
  }],
}
