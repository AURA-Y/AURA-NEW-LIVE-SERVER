import { Controller, Post, Get, Body, Param, UseInterceptors, UploadedFile, HttpException, HttpStatus, Res, Delete } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { LivekitService } from './livekit.service';
import { VoiceBotService } from './voice-bot.service';
import { SttService } from '../stt/stt.service';
// import { LlmService } from '../llm/llm.service'; // RAG로 대체
import { TtsService } from '../tts/tts.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { JoinRoomDto } from './dto/join-room.dto';

@Controller('room')
export class LivekitController {
  constructor(
    private readonly livekitService: LivekitService,
    private readonly voiceBotService: VoiceBotService,
    private readonly sttService: SttService,
    // private readonly llmService: LlmService, // RAG로 대체
    private readonly ttsService: TtsService,
  ) { }

  // AI 음성 봇 시작
  @Post('voice-bot/:roomName')
  async startVoiceBot(@Param('roomName') roomName: string) {
    console.log(`[AI 봇 요청] 방: ${roomName}`);

    try {
      // 봇 전용 토큰 생성
      const { token } = await this.livekitService.joinRoom({
        userName: `ai-bot-${Math.floor(Math.random() * 1000)}`,
        roomName: roomName,
      }, true);

      // 봇 시작
      await this.voiceBotService.startBot(roomName, token);

      return {
        success: true,
        message: `AI 봇이 방 '${roomName}'에 입장했습니다.`,
        roomName: roomName,
      };
    } catch (error) {
      throw new HttpException(`AI 봇 시작 실패: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // AI 음성 봇 종료
  @Delete('voice-bot/:roomName')
  async stopVoiceBot(@Param('roomName') roomName: string) {
    await this.voiceBotService.stopBot(roomName);
    return { success: true, message: `AI 봇이 방 '${roomName}'에서 퇴장했습니다.` };
  }

  // AI 봇 상태 확인
  @Get('voice-bot/:roomName/status')
  async getVoiceBotStatus(@Param('roomName') roomName: string) {
    const isActive = this.voiceBotService.isActive(roomName);
    return { roomName, active: isActive };
  }


  @Post('create')
  async createRoom(@Body() createRoomDto: CreateRoomDto) {
    return this.livekitService.createRoom(createRoomDto);
  }

  @Post('join')
  async joinRoom(@Body() joinRoomDto: JoinRoomDto) {
    return this.livekitService.joinRoom(joinRoomDto);
  }

  @Get(':roomId')
  async getRoom(@Param('roomId') roomId: string) {
    return this.livekitService.getRoom(roomId);
  }

  // 오디오 파일로 STT 테스트 (마이크 없이 테스트용)
  @Post('stt-test')
  @UseInterceptors(FileInterceptor('audio'))
  async testStt(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new HttpException('오디오 파일이 필요합니다', HttpStatus.BAD_REQUEST);
    }

    console.log(`[STT 테스트] 파일: ${file.originalname}, 크기: ${file.size} bytes`);

    try {
      const transcript = await this.sttService.transcribeFromBuffer(file.buffer, file.originalname);
      return {
        success: true,
        fileName: file.originalname,
        fileSize: file.size,
        transcript: transcript,
      };
    } catch (error) {
      throw new HttpException(`STT 실패: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /*
  // STT→LLM 테스트 엔드포인트 (주석처리 - RAG로 대체)
  @Post('stt-llm-test')
  @UseInterceptors(FileInterceptor('audio'))
  async testSttToLlm(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new HttpException('오디오 파일이 필요합니다', HttpStatus.BAD_REQUEST);
    }

    console.log(`[STT→LLM 테스트] 파일: ${file.originalname}, 크기: ${file.size} bytes`);

    try {
      // 1. STT: 음성 → 텍스트
      const transcript = await this.sttService.transcribeFromBuffer(file.buffer, file.originalname);
      console.log(`[STT 완료] ${transcript}`);

      // 2. LLM: 텍스트 → AI 응답
      const llmResponse = await this.llmService.sendMessage(transcript);
      console.log(`[LLM 완료] ${llmResponse.substring(0, 100)}...`);

      return {
        success: true,
        fileName: file.originalname,
        fileSize: file.size,
        transcript: transcript,
        llmResponse: llmResponse,
      };
    } catch (error) {
      throw new HttpException(`STT→LLM 실패: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
  */

  /*
  // 전체 파이프라인: STT + LLM + TTS → 오디오 응답 (주석처리 - RAG로 대체)
  @Post('voice-chat')
  @UseInterceptors(FileInterceptor('audio'))
  async voiceChat(
    @UploadedFile() file: Express.Multer.File,
    @Res() res: Response,
  ) {
    if (!file) {
      throw new HttpException('오디오 파일이 필요합니다', HttpStatus.BAD_REQUEST);
    }

    const totalStart = Date.now();
    console.log(`\n========== [음성 채팅 시작] ==========`);
    console.log(`파일: ${file.originalname}, 크기: ${file.size} bytes`);

    try {
      // 1. STT: 음성 → 텍스트
      const sttStart = Date.now();
      const transcript = await this.sttService.transcribeFromBuffer(file.buffer, file.originalname);
      const sttLatency = Date.now() - sttStart;
      console.log(`[STT] ${sttLatency}ms - "${transcript}"`);

      // 2. LLM: 텍스트 → AI 응답
      const llmStart = Date.now();
      const llmResponse = await this.llmService.sendMessage(transcript);
      const llmLatency = Date.now() - llmStart;
      console.log(`[LLM] ${llmLatency}ms - "${llmResponse.substring(0, 50)}..."`);

      // 3. TTS: AI 응답 → 음성
      const ttsStart = Date.now();
      const audioBuffer = await this.ttsService.synthesize(llmResponse);
      const ttsLatency = Date.now() - ttsStart;
      console.log(`[TTS] ${ttsLatency}ms - ${audioBuffer.length} bytes`);

      const totalLatency = Date.now() - totalStart;
      console.log(`========== [완료] 총 ${totalLatency}ms ==========`);
      console.log(`  STT: ${sttLatency}ms | LLM: ${llmLatency}ms | TTS: ${ttsLatency}ms\n`);

      // MP3 파일로 응답 (레이턴시 정보 헤더에 포함)
      res.set({
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.length,
        'X-Latency-Total': totalLatency.toString(),
        'X-Latency-STT': sttLatency.toString(),
        'X-Latency-LLM': llmLatency.toString(),
        'X-Latency-TTS': ttsLatency.toString(),
        'X-Transcript': encodeURIComponent(transcript),
      });

      res.send(audioBuffer);
    } catch (error) {
      throw new HttpException(`음성 채팅 실패: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
  */


  // TTS만 테스트 (Polly 권한 확인용)
  @Post('tts-test')
  async testTts(@Body('text') text: string, @Res() res: Response) {
    if (!text) {
      text = '안녕하세요, TTS 테스트입니다.';
    }

    console.log(`[TTS 테스트] 텍스트: ${text}`);

    try {
      const audioBuffer = await this.ttsService.synthesize(text);
      console.log(`[TTS 완료] 오디오 크기: ${audioBuffer.length} bytes`);

      res.set({
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.length,
      });

      res.send(audioBuffer);
    } catch (error) {
      console.error(`[TTS 에러] ${error.message}`);
      throw new HttpException(`TTS 실패: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}




@Controller()
export class ApiController {
  constructor(private readonly livekitService: LivekitService) { }

  @Get('health')
  health() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('rooms')
  async listRooms() {
    return this.livekitService.listRooms();
  }

  @Post('token')
  async generateToken(@Body() joinRoomDto: JoinRoomDto) {
    return this.livekitService.joinRoom(joinRoomDto);
  }
}
