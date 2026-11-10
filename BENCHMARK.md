# Compare Full and Lite pose models

1. Run `npm ci` and `npm run dev`. In the tracker, open **Show details → Test video → Open the pose benchmark**, or visit `/benchmark.html`.
2. Choose a local video (H.264 MP4 or WebM), exercise, and the person's left or right side. Use the same clip and settings for repeat runs. The default is 10 samples/s; lower the rate or shorten the clip if it exceeds 1,200 samples.
3. Select **Run**, then **Download CSV**. The benchmark uses no webcam and does not upload clips, labels, or results. It loads the same pinned MediaPipe float16 v1 model assets as the tracker.

Both fresh CPU models get the same canvas pixels at each requested clip time. The browser selects the decoded frame at the seek position; the exported time is the **requested** time, not the frame's presentation timestamp. Images are scaled to at most 640 px on the long side. The benchmark measures raw 2D angles using the chosen exercise profile; live tracking may use a different backend, smoothing, and 3D estimation.

The CSV contains one row per model per sample, with the sample index, requested time, exercise, side, rate, frame dimensions, measured angles, visibility and inference duration. Empty cells mean unavailable values. The summary counts missing poses and unavailable rep angles separately; unavailable angles include frames with no pose. Coverage is the fraction with a usable rep angle.

**Inference time** measures the synchronous MediaPipe call, including any input transfer performed inside that call. The median and nearest-rank p95 exclude model loading, seek/decode, drawing and feedback. They do not measure total live camera-to-feedback latency. Compare speed on the same device, browser and settings.

## Optional reference angles

First export a run and use its requested times and zero-based sample indices to label the same clip with the same exercise, side, and sampling rate. Match the 2D projected angle for the exercise's rep metric (for example, shoulder–elbow–wrist for a curl). Omit unlabelled indices; do not leave the angle blank.

```csv
sample_index,angle_deg
0,150
5,90.5
```

Each model shows mean absolute error (MAE) over its matched labels and over the subset where **both** models measured an angle. Use common-frame MAE together with coverage; error on the subset says nothing about frames a model missed. Without reference labels, the benchmark reports coverage and timing only.
