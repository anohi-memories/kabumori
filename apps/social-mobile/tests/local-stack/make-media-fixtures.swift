// G1 TASK 43 (local test fixture only): writes a real 1-second 64x64 H.264 MP4 with AVFoundation, for the media box run.
// Usage: xcrun swift make-media-fixtures.swift <out.mp4>
import AVFoundation
import CoreVideo

let url = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.removeItem(at: url)
let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 64, AVVideoHeightKey: 64])
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB, kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 64,
])
writer.add(input)
guard writer.startWriting() else { print("FAILED start \(String(describing: writer.error))"); exit(1) }
writer.startSession(atSourceTime: .zero)
for frame in 0..<10 {
  while !input.isReadyForMoreMediaData { usleep(1000) }
  var buffer: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer)
  guard let pixels = buffer else { print("FAILED buffer"); exit(1) }
  CVPixelBufferLockBaseAddress(pixels, [])
  memset(CVPixelBufferGetBaseAddress(pixels)!, Int32(frame * 20), CVPixelBufferGetDataSize(pixels))
  CVPixelBufferUnlockBaseAddress(pixels, [])
  adaptor.append(pixels, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: 10))
}
input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
guard writer.status == .completed else { print("FAILED \(String(describing: writer.error))"); exit(1) }
print("ok")
