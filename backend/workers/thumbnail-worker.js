const { parentPort, workerData } = require('worker_threads');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs').promises;

// 增加对损坏或非标准图片文件的容错处理
async function generateImageThumbnail(imagePath, thumbPath) {
    const mainProcessing = async () => {
        const metadata = await sharp(imagePath, { limitInputPixels: false }).metadata();
        const pixelCount = (metadata.width || 1) * (metadata.height || 1);
        let dynamicQuality;

        if (pixelCount > 8000000) {
            dynamicQuality = 65;
        } else if (pixelCount > 2000000) {
            dynamicQuality = 70;
        } else {
            dynamicQuality = 80;
        }

        await sharp(imagePath, { limitInputPixels: false })
            .resize({ width: 500 })
            .webp({ quality: dynamicQuality })
            .toFile(thumbPath);
    };

    try {
        await mainProcessing();
        return { success: true };
    } catch (error) {
        console.warn(`[WORKER] 图片: ${path.basename(imagePath)} 首次处理失败，原因: ${error.message}. 尝试进入安全模式...`);
        
        try {
            // 使用 failOn: 'none' 模式，让 sharp 尽可能忽略错误，完成转换
            await sharp(imagePath, { limitInputPixels: false, failOn: 'none' })
                .resize({ width: 500 })
                .webp({ quality: 60 }) // 在安全模式下使用稍低的质量
                .toFile(thumbPath);
            
            console.log(`[WORKER] 图片: ${path.basename(imagePath)} 在安全模式下处理成功。`);
            return { success: true };
        } catch (safeError) {
            // 如果连安全模式都失败了，那这个文件确实有问题
            console.error(`[WORKER] 图片: ${path.basename(imagePath)} 在安全模式下处理失败:`, safeError.message);
            return { success: false, error: 'PROCESSING_FAILED_IN_SAFE_MODE', message: safeError.message };
        }
        // --- ↑↑↑ 修改结束 ↑↑↑ ---
    }
}


// [智能优化] 寻找视频的“黄金帧”作为封面

async function generateVideoThumbnail(videoPath, thumbPath) {
    const tempDir = path.dirname(thumbPath);
    const tempFilenamePattern = `candidate-${path.basename(thumbPath, '.jpg')}-%i.png`;

    return new Promise((resolve) => {
        ffmpeg(videoPath)
            .on('end', async () => {
                try {
                    let bestCandidatePath = '';
                    let maxStdDev = -1;

                    for (let i = 1; i <= 5; i++) {
                        const candidateFilename = tempFilenamePattern.replace('%i', i);
                        const candidatePath = path.join(tempDir, candidateFilename);
                        
                        try {
                            const stats = await sharp(candidatePath).stats();
                            const stdDev = stats.channels.reduce((acc, c) => acc + c.stdev, 0);

                            if (stdDev > maxStdDev) {
                                maxStdDev = stdDev;
                                bestCandidatePath = candidatePath;
                            }
                        } catch (e) {
                            // Ignore corrupted candidates
                        }
                    }

                    if (!bestCandidatePath) {
                        const firstCandidate = path.join(tempDir, tempFilenamePattern.replace('%i', 1));
                        // Check if the first candidate file exists before using it
                        try {
                            await fs.access(firstCandidate);
                            bestCandidatePath = firstCandidate;
                        } catch (e) {
                            // If no candidates are valid, resolve with failure
                            resolve({ success: false, error: 'NO_VALID_CANDIDATE_FRAMES' });
                            return;
                        }
                    }
                    
                    await sharp(bestCandidatePath)
                        .resize({ width: 320 })
                        .jpeg({ quality: 80 })
                        .toFile(thumbPath);

                    // Cleanup temporary files
                    for (let i = 1; i <= 5; i++) {
                       const candidateFilename = tempFilenamePattern.replace('%i', i);
                       await fs.unlink(path.join(tempDir, candidateFilename)).catch(()=>{});
                    }

                    resolve({ success: true });
                } catch (err) {
                    resolve({ success: false, error: err.message });
                }
            })
            .on('error', (err) => {
                resolve({ success: false, error: err.message });
            })
            .screenshots({
                count: 5,
                timemarks: ['10%', '30%', '50%', '70%', '90%'],
                filename: tempFilenamePattern,
                folder: tempDir,
                size: '320x?'
            });
    });
}


parentPort.on('message', async (task) => {
    const { filePath, relativePath, type, thumbsDir } = task;
    const isVideo = type === 'video';
    const extension = isVideo ? '.jpg' : '.webp';
    const safeFileName = relativePath.replace(/[^a-zA-Z0-9]/g, '_') + extension;
    const thumbPath = path.join(thumbsDir, safeFileName);

    // 新增：如果缩略图已存在，直接跳过
    try {
        await fs.access(thumbPath);
        parentPort.postMessage({ success: true, skipped: true, task, workerId: workerData.workerId });
        return;
    } catch (e) {
        // 文件不存在才继续生成
    }
    
    let result;
    if (isVideo) {
        result = await generateVideoThumbnail(filePath, thumbPath);
    } else {
        result = await generateImageThumbnail(filePath, thumbPath);
    }

    parentPort.postMessage({ ...result, task, workerId: workerData.workerId });
});
