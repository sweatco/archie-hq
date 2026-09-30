import AVFoundation

let asset = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
let duration = try await asset.load(.duration).seconds
guard duration.isFinite, duration >= 10,
      let track = try await asset.loadTracks(withMediaType: .video).first else {
    fatalError("Recording must contain at least ten seconds of video")
}
let size = try await track.load(.naturalSize)
let reader = try AVAssetReader(asset: asset)
let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
])
reader.add(output)
guard reader.startReading() else { fatalError("Could not open recording: \(String(describing: reader.error))") }
var frames = 0
while let sample = output.copyNextSampleBuffer() {
    guard CMSampleBufferGetImageBuffer(sample) != nil else { fatalError("Undecodable video frame") }
    frames += 1
}
guard reader.status == .completed, frames >= 10, size.width > 0, size.height > 0 else {
    fatalError("Incomplete recording: \(String(describing: reader.error))")
}
let summary: [String: Any] = ["durationSeconds": duration, "decodedFrames": frames, "width": size.width, "height": size.height]
let data = try JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys])
print(String(decoding: data, as: UTF8.self))
