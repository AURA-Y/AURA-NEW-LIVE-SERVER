import { Controller, Post, Get, Body, Param, UseInterceptors, UploadedFile, HttpException, HttpStatus, Res, Delete, Query } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { LivekitService } from './livekit.service';
import { VoiceBotService } from './voice-bot.service';
import { SttService } from '../stt/stt.service';
import { LlmService } from '../llm/llm.service'; //통합 검색
import { TtsService } from '../tts/tts.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { JoinRoomDto } from './dto/join-room.dto';

@Controller('room')
export class LivekitController {
  constructor(
    private readonly livekitService: LivekitService,
    private readonly voiceBotService: VoiceBotService,
    private readonly sttService: SttService,
    private readonly llmService: LlmService, //통합 검색 
    private readonly ttsService: TtsService,
  ) { }

  // AI 음성 봇 시작
  @Post('voice-bot/:roomName')
  async startVoiceBot(@Param('roomName') roomName: string) {
    const normalizedRoomName = roomName.trim();
    console.log(`[AI 봇 요청] 방: ${normalizedRoomName}`);

    try {
      if (this.voiceBotService.isActive(normalizedRoomName)) {
        await this.voiceBotService.stopBot(normalizedRoomName);
      }
      await this.livekitService.removeBots(normalizedRoomName);

      // 봇 전용 토큰 생성
      const { token } = await this.livekitService.joinRoom({
        userName: `ai-bot-${Math.floor(Math.random() * 1000)}`,
        roomName: normalizedRoomName,
      }, true);

      // 봇 시작
      await this.voiceBotService.startBot(normalizedRoomName, token);

      return {
        success: true,
        message: `AI 봇이 방 '${normalizedRoomName}'에 입장했습니다.`,
        roomName: normalizedRoomName,
      };
    } catch (error) {
      throw new HttpException(`AI 봇 시작 실패: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // AI 음성 봇 종료
  @Delete('voice-bot/:roomName')
  async stopVoiceBot(@Param('roomName') roomName: string) {
    const normalizedRoomName = roomName.trim();
    await this.voiceBotService.stopBot(normalizedRoomName);
    return { success: true, message: `AI 봇이 방 '${normalizedRoomName}'에서 퇴장했습니다.` };
  }

  // AI 봇 상태 확인
  @Get('voice-bot/:roomName/status')
  async getVoiceBotStatus(@Param('roomName') roomName: string) {
    const normalizedRoomName = roomName.trim();
    const isActive = this.voiceBotService.isActive(normalizedRoomName);
    return { roomName: normalizedRoomName, active: isActive };
  }


  @Post('create')
  async createRoom(@Body() createRoomDto: CreateRoomDto) {
    const result = await this.livekitService.createRoom(createRoomDto);
    const normalizedRoomTitle = result.roomTitle.trim();

    // 방 생성 시 자동으로 Voice Bot 시작
    try {
      if (this.voiceBotService.isActive(normalizedRoomTitle)) {
        await this.voiceBotService.stopBot(normalizedRoomTitle);
      }
      await this.livekitService.removeBots(normalizedRoomTitle);
      const { token } = await this.livekitService.joinRoom({
        userName: `ai-bot-${Math.floor(Math.random() * 1000)}`,
        roomName: normalizedRoomTitle,
      }, true);

      await this.voiceBotService.startBot(normalizedRoomTitle, token);
      console.log(`[자동 봇 시작] 방 '${normalizedRoomTitle}'에 봇이 자동으로 입장했습니다.`);
    } catch (error) {
      console.error(`[자동 봇 시작 실패] ${error.message}`);
      // 봇 시작 실패해도 방 생성은 성공으로 처리
    }

    return result;
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
      console.log(`[LLM 완료] ${llmResponse.text.substring(0, 100)}...`);

      return {
        success: true,
        fileName: file.originalname,
        fileSize: file.size,
        transcript: transcript,
        llmResponse: llmResponse.text,
        searchResults: llmResponse.searchResults,
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
      console.log(`[LLM] ${llmLatency}ms - "${llmResponse.text.substring(0, 50)}..."`);

      // 3. TTS: AI 응답 → 음성
      const ttsStart = Date.now();
      const audioBuffer = await this.ttsService.synthesize(llmResponse.text);
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
  constructor(
    private readonly livekitService: LivekitService,
    private readonly llmService: LlmService,
  ) { }

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

  @Get('map/static')
  async getStaticMap(
    @Query('originLng') originLng: string,
    @Query('originLat') originLat: string,
    @Query('destLng') destLng: string,
    @Query('destLat') destLat: string,
    @Query('width') width: string,
    @Query('height') height: string,
    @Res() res: Response,
  ) {
    if (!originLng || !originLat || !destLng || !destLat) {
      throw new HttpException('origin/destination 좌표가 필요합니다.', HttpStatus.BAD_REQUEST);
    }

    const image = await this.llmService.getStaticMapImage({
      origin: { lng: originLng, lat: originLat },
      destination: { lng: destLng, lat: destLat },
      width: Number(width) || 1120,
      height: Number(height) || 196,
    });

    if (!image) {
      throw new HttpException('Static Map 생성 실패', HttpStatus.BAD_GATEWAY);
    }

    res.set({
      'Content-Type': image.contentType,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });

    res.send(image.buffer);
  }
}
