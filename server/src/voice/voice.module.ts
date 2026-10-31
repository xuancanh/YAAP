/**
 * VoiceModule — voice notes (docs/voice.md): transcription of audio
 * attachments on upload (used by the workspace and agent file endpoints) and
 * optional text-to-speech for replies.
 *
 *  GET  /api/voice/status → { transcription, tts, model }
 *  POST /api/voice/tts    { text, voice? } → audio/mpeg stream
 */
import { Body, Controller, Get, Module, Post, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { AgentTypesModule } from '../agent-types/agent-types.module';
import { MAX_TTS_CHARS, TranscriptionService } from './transcription.service';

class TtsDto {
  /** Longer replies are cut at the provider's 4096-char ceiling server-side. */
  @IsString() @MaxLength(MAX_TTS_CHARS * 8) text!: string;
  @IsOptional() @IsString() @MaxLength(40) voice?: string;
}

@Controller('voice')
export class VoiceController {
  constructor(private readonly voice: TranscriptionService) {}

  @Get('status') status() { return this.voice.status(); }

  @Post('tts')
  async tts(@Body() dto: TtsDto, @Res() res: Response) {
    const upstream = await this.voice.speak(dto.text, dto.voice);
    if (!upstream || !upstream.body) throw new ServiceUnavailableException('text-to-speech is not configured');
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    Readable.fromWeb(upstream.body as unknown as WebReadableStream).pipe(res);
  }
}

@Module({
  imports: [AgentTypesModule],
  controllers: [VoiceController],
  providers: [TranscriptionService],
  exports: [TranscriptionService],
})
export class VoiceModule {}
