const { parentPort } = require('worker_threads');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const util = require('util');

const execPromise = util.promisify(exec);

async function isOptimized(filePath) {
    let fileHandle;
    try {
        fileHandle = await fs.open(filePath, 'r');
        // 通常 moov atom 会出现在文件的前 64KB 内。
        // 读取一个合理的块大小以进行检查，避免读取整个大文件。
        const bufferSize = 64 * 1024; 
        const buffer = Buffer.alloc(bufferSize);

        const { bytesRead } = await fileHandle.read(buffer, 0, bufferSize, 0);

        if (bytesRead < 4) {
            // 文件太小，不可能包含有效的 moov atom
            return true; // 视作无需处理
        }
        
        // 在读取到的数据块中搜索 'moov' 标志
        // toHexString() 是 Node.js 20+ 的方法，这里用 Buffer.indexOf
        const moovPosition = buffer.indexOf('moov', 0, 'ascii');

        // 同时搜索 'mdat' (媒体数据) 标志作为参考
        const mdatPosition = buffer.indexOf('mdat', 0, 'ascii');
        
        // 如果找到了 moov，并且它出现在 mdat 之前（或者根本没找到 mdat），
        // 那么我们可以高度确信它是优化过的。
        if (moovPosition !== -1 && (mdatPosition === -1 || moovPosition < mdatPosition)) {
            return true;
        }

        return false;
    } catch (e) {
        console.error(`[VIDEO-PROCESSOR] 检查视频优化状态失败 ${filePath}:`, e);
        // 如果检查失败，为避免意外，默认认为它未被优化，让主流程继续处理。
        return false;
    } finally {
        if (fileHandle) {
            await fileHandle.close();
        }
    }
}

/**
 * 使用 ffmpeg 将视频的 moov atom 移动到文件头部 (faststart)。
 * @param {string} filePath - 原始视频文件的路径。
 * @returns {Promise<{success: boolean, path: string, error?: string}>}
 */
async function optimizeVideo(filePath) {
    const tempPath = path.join(path.dirname(filePath), `temp_${path.basename(filePath)}`);
    // 使用 -movflags +faststart 选项来移动 moov atom
    const command = `ffmpeg -i "${filePath}" -c copy -movflags +faststart "${tempPath}"`;

    try {
        await execPromise(command);
        // 优化成功后，用临时文件替换原始文件
        await fs.rename(tempPath, filePath);
        return { success: true, path: filePath };
    } catch (error) {
        // 如果 ffmpeg 失败，确保删除可能已创建的临时文件
        await fs.unlink(tempPath).catch(() => {}); // 忽略删除失败的错误
        return { success: false, path: filePath, error: error.message };
    }
}

parentPort.on('message', async (task) => {
    const { filePath } = task;
    console.log(`[VIDEO-PROCESSOR] 接到任务: ${filePath}`);

    if (await isOptimized(filePath)) {
        console.log(`[VIDEO-PROCESSOR] 视频已优化，跳过: ${filePath}`);
        parentPort.postMessage({ success: true, path: filePath, status: 'skipped' });
        return;
    }

    console.log(`[VIDEO-PROCESSOR] 视频需要优化，开始处理: ${filePath}`);
    const result = await optimizeVideo(filePath);
    if (result.success) {
        console.log(`[VIDEO-PROCESSOR] 成功优化: ${filePath}`);
    } else {
        console.error(`[VIDEO-PROCESSOR] 优化失败: ${filePath}`, result.error);
    }
    
    parentPort.postMessage(result);
});