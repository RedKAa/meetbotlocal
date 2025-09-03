import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { log } from './utils';

const execPromise = promisify(exec);

/**
 * Converts a RAW audio file to WAV format using ffmpeg
 * @param inputPath Path to the input RAW file
 * @param outputPath Path for the output WAV file
 * @param sampleRate Sample rate of the RAW audio (default: 44100)
 * @param channels Number of audio channels (default: 1)
 */
export async function convertRawToWav(
  inputPath: string,
  outputPath: string,
  sampleRate: number = 44100,
  channels: number = 1
): Promise<void> {
  try {
    // Check if input file exists
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file does not exist: ${inputPath}`);
    }

    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Construct ffmpeg command
    const command = `ffmpeg -f f32le -ar ${sampleRate} -ac ${channels} -i "${inputPath}" "${outputPath}"`;
    
    log(`Converting RAW audio to WAV: ${command}`);
    
    // Execute the conversion
    const { stdout, stderr } = await execPromise(command);
    
    if (stderr) {
      log(`FFmpeg stderr: ${stderr}`);
    }
    
    log(`Successfully converted RAW to WAV: ${outputPath}`);
  } catch (error: any) {
    log(`Error converting RAW to WAV: ${error.message}`);
    throw error;
  }
}

/**
 * Converts a RAW audio file to MP3 format using ffmpeg
 * @param inputPath Path to the input RAW file
 * @param outputPath Path for the output MP3 file
 * @param sampleRate Sample rate of the RAW audio (default: 44100)
 * @param channels Number of audio channels (default: 1)
 * @param bitrate Audio bitrate for MP3 (default: 128k)
 */
export async function convertRawToMp3(
  inputPath: string,
  outputPath: string,
  sampleRate: number = 44100,
  channels: number = 1,
  bitrate: string = '128k'
): Promise<void> {
  try {
    // Check if input file exists
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file does not exist: ${inputPath}`);
    }

    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Construct ffmpeg command
    const command = `ffmpeg -f f32le -ar ${sampleRate} -ac ${channels} -i "${inputPath}" -ab ${bitrate} "${outputPath}"`;
    
    log(`Converting RAW audio to MP3: ${command}`);
    
    // Execute the conversion
    const { stdout, stderr } = await execPromise(command);
    
    if (stderr) {
      log(`FFmpeg stderr: ${stderr}`);
    }
    
    log(`Successfully converted RAW to MP3: ${outputPath}`);
  } catch (error: any) {
    log(`Error converting RAW to MP3: ${error.message}`);
    throw error;
  }
}