// Exercise-specific prototype values. These are not clinical safety limits.
// Add profiles with their own landmarks, metrics, repetition phases and form rules.
// facing is the stance angles are measured from ('camera' or 'side');
// rep.cues explain partial reps; an optional tempo block times the lift and lowering.
// loadStart is where the weight starts each rep, for the dumbbell sensor: 'bottom'
// (lift, then lower) or 'top' (lower, then lift).
// Metrics are either [a, joint, c] (angle at the middle joint) or
// { segment:[from, to], reference:'vertical' } (segment angle away from straight up).
// Form rules warn above max (clearing at clearBelow) or below min (clearing at clearAbove).
// safety.maxLean is the torso lean (degrees from vertical) that looks off balance;
// it defaults to 20° sideways for exercises facing the camera (see src/safety.js).

// MediaPipe pose landmark indices; "left" is the person's own left.
const JOINTS = {
  left: { shoulder:11, elbow:13, wrist:15, hip:23, knee:25, ankle:27 },
  right: { shoulder:12, elbow:14, wrist:16, hip:24, knee:26, ankle:28 },
}

function sides(...names) {
  const pick = side => Object.fromEntries(names.map(name => [name, JOINTS[side][name]]))
  return { left: pick('left'), right: pick('right') }
}

export const curl = {
  id: 'bicep-curl',
  loadStart: 'bottom',
  name: 'Bicep curl',
  instructions: 'Face the camera straight on with both arms visible. A banner tells you which way to turn if you drift.',
  facing: 'camera',
  startCue: 'Begin with your arm extended.',
  landmarks: sides('shoulder','elbow','wrist','hip'),
  metrics: {
    elbow: ['shoulder','elbow','wrist'],
    upperArm: ['elbow','shoulder','hip'],
  },
  labels: { elbow:'Elbow angle', upperArm:'Upper arm / torso' },
  connections: [['shoulder','elbow'],['elbow','wrist'],['shoulder','hip','reference']],
  defaultSide: 'each',
  minVisibility: 0.5,
  maxGapMs: 1000,
  rep: {
    metric:'elbow', start:125, target:95, direction:'decreasing', holdMs:60,
    cues: {
      target:'Partial rep: curl the weight higher to count it.',
      start:'Partial rep: straighten your arm before the next curl.',
    },
  },
  // Measured turning point to turning point, which reads ~70-75% of the full phase
  // (the slow ends of each turnaround fall inside the settle band). So these limits
  // are ~0.7 s lift, ~1.1 s lowering and ~5 s per phase in real time.
  tempo: {
    minLiftMs:500, minLowerMs:800, maxPhaseMs:3500,
    hint:'Tempo aims for about a 1 s lift and 2 s lowering; pauses at the top and bottom are not timed.',
    messages: {
      fastLift:'Too fast: you swung the weight up. Lift over about 1 second.',
      fastLower:'Too fast: lower the weight with control over about 2 seconds.',
      slow:'Too slow: keep each lift and lowering under about 5 seconds.',
      stalled:'Too slow: keep the curl moving.',
    },
  },
  formRules: [{
    id:'raised-elbow', metric:'upperArm', max:30, clearBelow:25, holdMs:300,
    message:'Upper arm raised: keep your elbow closer to your side.',
  }],
}

export const squat = {
  id: 'squat',
  loadStart: 'top',
  name: 'Squat',
  instructions: 'Stand side-on with shoulder, hip, knee and ankle visible. Auto follows the clearer leg.',
  facing: 'side',
  startCue: 'Begin standing tall.',
  landmarks: sides('shoulder','hip','knee','ankle'),
  metrics: {
    knee: ['hip','knee','ankle'],
    torsoLean: { segment:['hip','shoulder'], reference:'vertical' },
  },
  labels: { knee:'Knee angle', torsoLean:'Torso lean' },
  connections: [['hip','knee'],['knee','ankle'],['hip','shoulder']],
  defaultSide: 'auto',
  safety: { maxLean:70 },
  minVisibility: 0.6,
  maxGapMs: 1000,
  rep: { metric:'knee', start:160, target:100, direction:'decreasing', holdMs:60,
    cues: { target:'Partial rep: squat deeper to count it.', start:'Partial rep: stand up fully between squats.' } },
  formRules: [{
    id:'torso-lean', metric:'torsoLean', max:55, clearBelow:50, holdMs:300,
    message:'Chest dropping: keep your torso more upright.',
  }],
}

// One dumbbell held upright at the chest, which lets the torso stay more upright and
// the squat go deeper than a back squat.
export const gobletSquat = {
  id: 'goblet-squat',
  loadStart: 'top',
  name: 'Goblet squat',
  instructions: 'Stand side-on holding one dumbbell at your chest, with shoulder, hip, knee and ankle visible. Auto follows the clearer leg.',
  facing: 'side',
  startCue: 'Begin standing tall with the dumbbell at your chest.',
  landmarks: sides('shoulder','hip','knee','ankle'),
  metrics: {
    knee: ['hip','knee','ankle'],
    torsoLean: { segment:['hip','shoulder'], reference:'vertical' },
  },
  labels: { knee:'Knee angle', torsoLean:'Torso lean' },
  connections: [['hip','knee'],['knee','ankle'],['hip','shoulder']],
  defaultSide: 'auto',
  safety: { maxLean:60 },
  minVisibility: 0.6,
  maxGapMs: 1000,
  rep: { metric:'knee', start:160, target:95, direction:'decreasing', holdMs:60,
    cues: { target:'Partial rep: squat deeper to count it.', start:'Partial rep: stand up fully between squats.' } },
  formRules: [{
    id:'torso-lean', metric:'torsoLean', max:45, clearBelow:40, holdMs:300,
    message:'Chest dropping: keep the dumbbell close and your chest up.',
  }],
}

// Dumbbells lowered along the legs by hinging at the hips with a soft knee bend.
// The hip (shoulder-hip-knee) opens ~175° standing and closes to ~90-110° at the bottom.
export const deadlift = {
  id: 'dumbbell-deadlift',
  loadStart: 'top',
  name: 'Dumbbell deadlift',
  instructions: 'Stand side-on holding the dumbbells, with shoulder, hip, knee and ankle visible. Auto follows the clearer leg.',
  facing: 'side',
  startCue: 'Begin standing tall with the dumbbells at your thighs.',
  landmarks: sides('shoulder','hip','knee','ankle'),
  metrics: {
    hip: ['shoulder','hip','knee'],
    knee: ['hip','knee','ankle'],
  },
  labels: { hip:'Hip angle', knee:'Knee angle' },
  connections: [['hip','knee'],['knee','ankle'],['hip','shoulder']],
  defaultSide: 'auto',
  safety: { maxLean:null },
  minVisibility: 0.6,
  maxGapMs: 1000,
  rep: { metric:'hip', start:160, target:115, direction:'decreasing', holdMs:60,
    cues: {
      target:'Partial rep: hinge further forward to count it.',
      start:'Partial rep: stand up fully and squeeze your hips through between reps.',
    } },
  formRules: [{
    id:'squatting', metric:'knee', min:110, clearAbove:115, holdMs:300,
    message:'Knees bending too much: push your hips back instead of squatting down.',
  }],
}

export const shoulderPress = {
  id: 'shoulder-press',
  loadStart: 'bottom',
  name: 'Shoulder press',
  instructions: 'Face the camera with both shoulders, elbows, wrists and hips visible.',
  facing: 'camera',
  startCue: 'Begin with your hands at shoulder height.',
  landmarks: sides('shoulder','elbow','wrist','hip'),
  metrics: {
    armRaise: ['hip','shoulder','elbow'],
    elbow: ['shoulder','elbow','wrist'],
  },
  labels: { armRaise:'Arm elevation', elbow:'Elbow angle' },
  connections: [['shoulder','elbow'],['elbow','wrist'],['shoulder','hip','reference']],
  defaultSide: 'each',
  minVisibility: 0.5,
  maxGapMs: 1000,
  rep: { metric:'armRaise', start:100, target:150, direction:'increasing', holdMs:60,
    cues: { target:'Partial rep: press higher to count it.', start:'Partial rep: lower to shoulder height between presses.' } },
  formRules: [],
}

export const lateralRaise = {
  id: 'lateral-raise',
  loadStart: 'bottom',
  name: 'Lateral raise',
  instructions: 'Face the camera with both shoulders, elbows, wrists and hips visible.',
  facing: 'camera',
  startCue: 'Begin with your arms by your sides.',
  landmarks: sides('shoulder','elbow','wrist','hip'),
  metrics: {
    armRaise: ['hip','shoulder','elbow'],
    elbow: ['shoulder','elbow','wrist'],
  },
  labels: { armRaise:'Arm elevation', elbow:'Elbow angle' },
  connections: [['shoulder','elbow'],['elbow','wrist'],['shoulder','hip','reference']],
  defaultSide: 'each',
  minVisibility: 0.5,
  maxGapMs: 1000,
  rep: { metric:'armRaise', start:30, target:75, direction:'increasing', holdMs:60,
    cues: { target:'Partial rep: raise your arms higher to count it.', start:'Partial rep: lower your arms fully between raises.' } },
  formRules: [{
    id:'above-shoulder', metric:'armRaise', max:105, clearBelow:100, holdMs:300,
    message:'Arm above shoulder height: stop the raise at shoulder level.',
  }],
}

// Raising straight arms, thumbs up, in the scapular plane (about 30° forward of the
// sides) to shoulder height. Measured like a lateral raise: arm away from the torso.
export const scaption = {
  id: 'scaption',
  loadStart: 'bottom',
  name: 'Scaption',
  instructions: 'Face the camera with both shoulders, elbows, wrists and hips visible. Raise your arms in a V, slightly forward of your sides, thumbs up.',
  facing: 'camera',
  startCue: 'Begin with your arms by your sides, thumbs forward.',
  landmarks: sides('shoulder','elbow','wrist','hip'),
  metrics: {
    armRaise: ['hip','shoulder','elbow'],
    elbow: ['shoulder','elbow','wrist'],
  },
  labels: { armRaise:'Arm elevation', elbow:'Elbow angle' },
  connections: [['shoulder','elbow'],['elbow','wrist'],['shoulder','hip','reference']],
  defaultSide: 'each',
  minVisibility: 0.5,
  maxGapMs: 1000,
  rep: { metric:'armRaise', start:30, target:75, direction:'increasing', holdMs:60,
    cues: { target:'Partial rep: raise your arms higher to count it.', start:'Partial rep: lower your arms fully between raises.' } },
  tempo: {
    minLiftMs:500, minLowerMs:800, maxPhaseMs:3500,
    hint:'Tempo aims for about a 1 s raise and 2 s lowering; pauses at the top and bottom are not timed.',
    messages: {
      fastLift:'Too fast: you swung your arms up. Raise them over about 1 second.',
      fastLower:'Too fast: lower your arms with control over about 2 seconds.',
      slow:'Too slow: keep each raise and lowering under about 5 seconds.',
      stalled:'Too slow: keep the raise moving.',
    },
  },
  formRules: [
    { id:'above-shoulder', metric:'armRaise', max:105, clearBelow:100, holdMs:300,
      message:'Arm above shoulder height: stop the raise at shoulder level.' },
    { id:'bent-elbow', metric:'elbow', min:140, clearAbove:150, holdMs:300,
      message:'Elbows bending: keep your arms nearly straight.' },
  ],
}

// Bent-over or bench-supported. The elbow bends ~170° -> ~80° through the pull.
export const row = {
  id: 'dumbbell-row',
  loadStart: 'bottom',
  name: 'Dumbbell row',
  instructions: 'Stand side-on with shoulder, elbow, wrist and hip visible. Auto follows the arm that is rowing, not the one braced on the bench.',
  facing: 'side',
  startCue: 'Begin hinged forward with your arm hanging straight.',
  landmarks: sides('shoulder','elbow','wrist','hip'),
  metrics: {
    elbow: ['shoulder','elbow','wrist'],
    torsoLean: { segment:['hip','shoulder'], reference:'vertical' },
  },
  labels: { elbow:'Elbow angle', torsoLean:'Torso hinge' },
  connections: [['shoulder','elbow'],['elbow','wrist'],['hip','shoulder']],
  defaultSide: 'auto',
  safety: { maxLean:null },
  minVisibility: 0.5,
  maxGapMs: 1000,
  rep: {
    metric:'elbow', start:145, target:100, direction:'decreasing', holdMs:60,
    cues: {
      target:'Partial rep: pull your elbow further back to count it.',
      start:'Partial rep: let your arm hang straight before the next pull.',
    },
  },
  tempo: {
    minLiftMs:500, minLowerMs:800, maxPhaseMs:3500,
    hint:'Tempo aims for about a 1 s pull and 2 s lowering; pauses at the top and bottom are not timed.',
    messages: {
      fastLift:'Too fast: you yanked the weight up. Pull over about 1 second.',
      fastLower:'Too fast: lower the weight with control over about 2 seconds.',
      slow:'Too slow: keep each pull and lowering under about 5 seconds.',
      stalled:'Too slow: keep the row moving.',
    },
  },
  formRules: [{
    id:'upright-torso', metric:'torsoLean', min:30, clearAbove:35, holdMs:300,
    message:'Torso too upright: hinge forward at the hips.',
  }],
}

// Sitting upright on a chair, straightening the knee from ~90° to ~180°.
export const seatedLegRaise = {
  id: 'seated-leg-raise',
  loadStart: 'bottom',
  name: 'Seated leg raise',
  instructions: 'Sit side-on with shoulder, hip, knee and ankle visible. Raise the leg nearest the camera, then turn around for the other leg.',
  facing: 'side',
  startCue: 'Begin seated with your foot on the floor.',
  landmarks: sides('shoulder','hip','knee','ankle'),
  metrics: {
    knee: ['hip','knee','ankle'],
    torsoLean: { segment:['hip','shoulder'], reference:'vertical' },
  },
  labels: { knee:'Knee angle', torsoLean:'Torso lean' },
  connections: [['hip','knee'],['knee','ankle'],['hip','shoulder']],
  defaultSide: 'auto',
  safety: { maxLean:45 },
  minVisibility: 0.5,
  maxGapMs: 1000,
  rep: {
    metric:'knee', start:115, target:160, direction:'increasing', holdMs:60,
    cues: {
      target:'Partial rep: straighten your leg fully to count it.',
      start:'Partial rep: lower your foot back down before the next raise.',
    },
  },
  tempo: {
    minLiftMs:500, minLowerMs:800, maxPhaseMs:3500,
    hint:'Tempo aims for about a 1 s raise and 2 s lowering; holding at the top is not timed.',
    messages: {
      fastLift:'Too fast: you kicked your leg up. Raise it over about 1 second.',
      fastLower:'Too fast: lower your leg with control over about 2 seconds.',
      slow:'Too slow: keep each raise and lowering under about 5 seconds.',
      stalled:'Too slow: keep the raise moving.',
    },
  },
  formRules: [{
    id:'leaning-back', metric:'torsoLean', max:30, clearBelow:25, holdMs:300,
    message:'Sit up tall: keep your torso upright as you raise your leg.',
  }],
}

export const exercises = [curl, row, seatedLegRaise, squat, gobletSquat, deadlift, shoulderPress, lateralRaise, scaption]
