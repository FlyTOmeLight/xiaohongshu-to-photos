import AVFoundation
import AppKit
import ImageIO
import UniformTypeIdentifiers
let folder = URL(fileURLWithPath: CommandLine.arguments[1])
let image = NSImage(size: NSSize(width: 64, height: 64))
image.lockFocus()
NSColor.red.setFill(); NSRect(x: 0,y: 0,width: 64,height: 64).fill()
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .jpeg, properties: [:])!.write(to: folder.appendingPathComponent("image.jpg"))
let writer = try AVAssetWriter(outputURL: folder.appendingPathComponent("video.mov"), fileType: .mov)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey:AVVideoCodecType.h264,AVVideoWidthKey:64,AVVideoHeightKey:64])
let adapter = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput:input, sourcePixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32ARGB,kCVPixelBufferWidthKey as String:64,kCVPixelBufferHeightKey as String:64])
writer.add(input); writer.startWriting(); writer.startSession(atSourceTime:.zero)
for n in 0..<30 {
 while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval:0.01) }
 var pixel:CVPixelBuffer?; CVPixelBufferPoolCreatePixelBuffer(nil,adapter.pixelBufferPool!,&pixel)
 CVPixelBufferLockBaseAddress(pixel!,[])
 memset(CVPixelBufferGetBaseAddress(pixel!), Int32(n*8), CVPixelBufferGetDataSize(pixel!))
 CVPixelBufferUnlockBaseAddress(pixel!,[])
 adapter.append(pixel!,withPresentationTime:CMTime(value:Int64(n),timescale:30))
}
input.markAsFinished()
let semaphore = DispatchSemaphore(value:0)
writer.finishWriting { semaphore.signal() }; semaphore.wait()
if writer.status != .completed { throw writer.error! }
