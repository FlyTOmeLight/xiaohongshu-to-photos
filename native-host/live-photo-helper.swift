import AVFoundation
import CoreMedia
import Foundation
import ImageIO

enum LivePhotoError: LocalizedError {
    case invalidImage
    case imageWriteFailed
    case videoExportUnavailable
    case videoExportFailed(String)
    case metadataVerificationFailed

    var errorDescription: String? {
        switch self {
        case .invalidImage:
            return "无法读取实况照片的静态图"
        case .imageWriteFailed:
            return "无法写入实况照片的配对标识"
        case .videoExportUnavailable:
            return "无法创建实况照片视频转换任务"
        case .videoExportFailed(let detail):
            return "无法处理实况照片视频：\(detail)"
        case .metadataVerificationFailed:
            return "实况照片配对标识校验失败"
        }
    }
}

func temporarySibling(of url: URL, extension fileExtension: String) -> URL {
    url.deletingLastPathComponent()
        .appendingPathComponent(".rednote-\(UUID().uuidString)")
        .appendingPathExtension(fileExtension)
}

func replaceFile(at destination: URL, with source: URL) throws {
    let manager = FileManager.default
    try manager.removeItem(at: destination)
    try manager.moveItem(at: source, to: destination)
}

func stampImage(at url: URL, identifier: String) throws {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let imageType = CGImageSourceGetType(source) else {
        throw LivePhotoError.invalidImage
    }

    var properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
    var makerApple = properties[kCGImagePropertyMakerAppleDictionary] as? [String: Any] ?? [:]
    makerApple["17"] = identifier
    properties[kCGImagePropertyMakerAppleDictionary] = makerApple

    let outputURL = temporarySibling(of: url, extension: url.pathExtension)
    guard let destination = CGImageDestinationCreateWithURL(outputURL as CFURL, imageType, 1, nil) else {
        throw LivePhotoError.imageWriteFailed
    }
    CGImageDestinationAddImageFromSource(destination, source, 0, properties as CFDictionary)
    guard CGImageDestinationFinalize(destination) else {
        try? FileManager.default.removeItem(at: outputURL)
        throw LivePhotoError.imageWriteFailed
    }
    try replaceFile(at: url, with: outputURL)
}

func contentIdentifierMetadata(_ identifier: String) -> AVMetadataItem {
    let item = AVMutableMetadataItem()
    item.keySpace = .quickTimeMetadata
    item.key = "com.apple.quicktime.content.identifier" as NSString
    item.value = identifier as NSString
    item.dataType = kCMMetadataBaseDataType_UTF8 as String
    return item
}

func stampVideo(at url: URL, identifier: String) throws {
    let asset = AVURLAsset(url: url)
    guard let exportSession = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) else {
        throw LivePhotoError.videoExportUnavailable
    }

    let outputURL = temporarySibling(of: url, extension: "mov")
    exportSession.outputURL = outputURL
    exportSession.outputFileType = .mov
    exportSession.metadata = [contentIdentifierMetadata(identifier)]

    let semaphore = DispatchSemaphore(value: 0)
    exportSession.exportAsynchronously {
        semaphore.signal()
    }
    semaphore.wait()

    guard exportSession.status == .completed else {
        try? FileManager.default.removeItem(at: outputURL)
        let detail = exportSession.error?.localizedDescription ?? "未知错误"
        throw LivePhotoError.videoExportFailed(detail)
    }
    try replaceFile(at: url, with: outputURL)
}

func imageIdentifier(at url: URL) -> String? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let makerApple = properties[kCGImagePropertyMakerAppleDictionary] as? [String: Any] else {
        return nil
    }
    return makerApple["17"] as? String
}

func videoIdentifier(at url: URL) -> String? {
    let asset = AVURLAsset(url: url)
    return asset.metadata.first { item in
        (item.key as? String) == "com.apple.quicktime.content.identifier"
            && item.keySpace == .quickTimeMetadata
    }?.stringValue
}

func run() throws {
    guard CommandLine.arguments.count == 3 else {
        throw NSError(
            domain: "RednoteLivePhoto",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: "用法：live-photo-helper <图片> <视频>"]
        )
    }

    let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
    let videoURL = URL(fileURLWithPath: CommandLine.arguments[2])
    let identifier = UUID().uuidString
    try stampImage(at: imageURL, identifier: identifier)
    try stampVideo(at: videoURL, identifier: identifier)
    guard imageIdentifier(at: imageURL) == identifier,
          videoIdentifier(at: videoURL) == identifier else {
        throw LivePhotoError.metadataVerificationFailed
    }
    print(identifier)
}

do {
    try run()
} catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(1)
}
