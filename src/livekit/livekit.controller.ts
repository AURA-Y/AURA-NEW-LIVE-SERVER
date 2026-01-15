import { Controller, Post, Get, Body, Param, UseInterceptors, UploadedFile, HttpException, HttpStatus, Res, Delete, Query, Inject } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { LivekitService } from './livekit.service';
import { VoiceBotService } from './voice-bot.service';
import { SttService } from '../stt/stt.service';
import { LlmService } from '../llm/llm.service';
import { TtsService } from '../tts/tts.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { JoinRoomDto } from './dto/join-room.dto';
import { EmbedFilesDto } from './dto/embed-files.dto';
import { RAG_CLIENT, IRagClient } from '../rag/rag-client.interface';

@Controller('room')
export class LivekitController {
  constructor(
    private readonly livekitService: LivekitService,
    private readonly voiceBotService: VoiceBotService,
    private readonly sttService: SttService,
    private readonly llmService: LlmService,
    private readonly ttsService: TtsService,
    @Inject(RAG_CLIENT) private readonly ragClient: IRagClient,
  ) { }

  // AI 음성 봇 시작
  @Post('voice-bot/:roomId')
  async startVoiceBot(@Param('roomId') roomId: string) {
    const normalizedRoomId = roomId.trim();
    console.log(`[AI 봇 요청] 방: ${normalizedRoomId}`);

    try {
      await this.livekitService.startBotForRoom(normalizedRoomId);
      return {
        success: true,
        message: `AI 봇이 방 '${normalizedRoomId}'에 입장했습니다.`,
        roomId: normalizedRoomId,
      };
    } catch (error) {
      throw new HttpException(`AI 봇 시작 실패: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // AI 음성 봇 종료
  @Delete('voice-bot/:roomId')
  async stopVoiceBot(@Param('roomId') roomId: string) {
    const normalizedRoomId = roomId.trim();
    await this.livekitService.stopBotForRoom(normalizedRoomId);
    return { success: true, message: `AI 봇이 방 '${normalizedRoomId}'에서 퇴장했습니다.` };
  }

  // AI 봇 상태 확인
  @Get('voice-bot/:roomId/status')
  async getVoiceBotStatus(@Param('roomId') roomId: string) {
    const normalizedRoomId = roomId.trim();
    const isActive = this.livekitService.isBotActive(normalizedRoomId);
    return { roomId: normalizedRoomId, active: isActive };
  }

  // Vision 캡처 응답 수신 (DataChannel 64KB 제한 우회용)
  @Post('voice-bot/:roomId/vision-capture')
  async receiveVisionCapture(
    @Param('roomId') roomId: string,
    @Body() body: {
      requestId: number;
      imageBase64: string;
      cursorPosition?: { x: number; y: number };
      highlightedText?: string;
      screenWidth: number;
      screenHeight: number;
    }
  ) {
    const normalizedRoomId = roomId.trim();
    console.log(`[Vision HTTP] 캡처 수신 - room: ${normalizedRoomId}, requestId: ${body.requestId}, 크기: ${(body.imageBase64?.length / 1024).toFixed(1)}KB`);

    try {
      await this.voiceBotService.handleVisionCaptureFromHttp(normalizedRoomId, {
        type: 'vision_capture_response',
        requestId: body.requestId,
        imageBase64: body.imageBase64,
        cursorPosition: body.cursorPosition,
        highlightedText: body.highlightedText,
        screenWidth: body.screenWidth,
        screenHeight: body.screenHeight,
      });

      return { success: true, message: 'Vision 캡처 처리 시작' };
    } catch (error) {
      console.error(`[Vision HTTP] 에러: ${error.message}`);
      throw new HttpException(`Vision 캡처 처리 실패: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ============================================================
  // 연속 화면 이해 모드 엔드포인트 (OCR 텍스트 수신)
  // ============================================================

  /**
   * 화면 컨텍스트 추가 (OCR 텍스트 수신)
   * POST /room/voice-bot/:roomId/screen-context
   */
  @Post('voice-bot/:roomId/screen-context')
  async addScreenContext(
    @Param('roomId') roomId: string,
    @Body() body: {
      captureId: number;
      extractedText: string;
      captureIndex: number;
      timestamp: number;
      isLast: boolean;
    }
  ) {
    const normalizedRoomId = roomId.trim();
    console.log(`[Screen Context] 수신 - room: ${normalizedRoomId}, ` +
      `캡처 ${body.captureIndex + 1}, 텍스트 ${body.extractedText?.length || 0}자`);

    try {
      const result = this.voiceBotService.addScreenContext(normalizedRoomId, {
        captureId: body.captureId,
        extractedText: body.extractedText || '',
        captureIndex: body.captureIndex,
        timestamp: body.timestamp,
      });

      if (!result.success) {
        throw new HttpException(result.message, HttpStatus.NOT_FOUND);
      }

      return {
        success: true,
        message: result.message,
        captureIndex: body.captureIndex,
        isLast: body.isLast,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error(`[Screen Context] 에러: ${error.message}`);
      throw new HttpException(`화면 컨텍스트 추가 실패: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * 화면 컨텍스트 초기화
   * POST /room/voice-bot/:roomId/screen-context/clear
   */
  @Post('voice-bot/:roomId/screen-context/clear')
  async clearScreenContext(@Param('roomId') roomId: string) {
    const normalizedRoomId = roomId.trim();
    console.log(`[Screen Context] 초기화 요청 - room: ${normalizedRoomId}`);

    try {
      const result = this.voiceBotService.clearScreenContext(normalizedRoomId);

      if (!result.success) {
        throw new HttpException(result.message, HttpStatus.NOT_FOUND);
      }

      return { success: true, message: result.message };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error(`[Screen Context] 초기화 에러: ${error.message}`);
      throw new HttpException(`화면 컨텍스트 초기화 실패: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * 화면 컨텍스트 상태 조회
   * GET /room/voice-bot/:roomId/screen-context/status
   */
  @Get('voice-bot/:roomId/screen-context/status')
  async getScreenContextStatus(@Param('roomId') roomId: string) {
    const normalizedRoomId = roomId.trim();
    const status = this.voiceBotService.getScreenContextStatus(normalizedRoomId);

    return {
      roomId: normalizedRoomId,
      ...status,
    };
  }

  @Post('create')
  async createRoom(@Body() createRoomDto: CreateRoomDto) {
    const reqStart = Date.now();
    console.log(`\n========== [POST /room/create] 요청 시작 ==========`);
    console.log(`[+0ms] 요청 데이터:`, JSON.stringify(createRoomDto));

    const result = await this.livekitService.createRoom(createRoomDto);
    console.log(`[+${Date.now() - reqStart}ms] livekitService.createRoom() 완료`);

    const roomId = result.roomId;

    // 방 생성 시 자동으로 Voice Bot 시작 (응답 지연 방지를 위해 비동기 처리)
    console.log(`[+${Date.now() - reqStart}ms] Voice Bot 비동기 시작`);
    void this.livekitService.startBotForRoom(roomId).then(() => {
      console.log(`[자동 봇 시작] 방 '${roomId}' (${result.roomTopic})에 봇이 입장했습니다.`);
    }).catch((error) => {
      console.error(`[자동 봇 시작 실패] ${error.message}`);
      // 봇 시작 실패해도 방 생성은 성공으로 처리
    });

    console.log(`[+${Date.now() - reqStart}ms] ✅ 응답 반환`);
    console.log(`========== [POST /room/create] 완료 ==========\n`);
    return result;
  }

  @Post('join')
  async joinRoom(@Body() joinRoomDto: JoinRoomDto) {
    return this.livekitService.joinRoom(joinRoomDto);
  }

  @Post('embed-files')
  async embedFiles(@Body() embedFilesDto: EmbedFilesDto) {
    const { roomId, files, topic, description } = embedFilesDto;

    try {
      const result = await this.livekitService.embedFiles(roomId, files, topic, description);
      return {
        success: result.success,
        roomId,
        message: result.message || '임베딩 요청 완료',
        files,
      };
    } catch (error) {
      throw new HttpException(`파일 임베딩 실패: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ============================================================
  // 시연용 목업 데이터 엔드포인트 (/:roomId 와일드카드보다 먼저 정의)
  // ============================================================

  /**
   * 실시간 대화 데이터 주입 (플로우차트 생성 테스트용)
   * POST /room/mock/conversation
   */
  @Post('mock/conversation')
  async injectMockConversation(
    @Body() body: {
      roomId: string;
      utterances: Array<{ speaker: string; text: string }>;
    }
  ) {
    const { roomId, utterances } = body;

    if (!roomId || !utterances || utterances.length === 0) {
      throw new HttpException('roomId와 utterances 배열이 필요합니다.', HttpStatus.BAD_REQUEST);
    }

    console.log(`\n========== [목업 대화 주입] ==========`);
    console.log(`Room ID: ${roomId}`);
    console.log(`발언 수: ${utterances.length}개`);

    try {
      // RAG 버퍼에 목업 데이터 주입
      const result = this.ragClient.injectMockStatements(roomId, utterances);

      return {
        success: result.success,
        roomId,
        injected: result.injected,
        message: `${result.injected}개의 발언이 RAG 버퍼에 주입되었습니다.`,
      };
    } catch (error) {
      console.error(`[목업 대화 주입 실패] ${error.message}`);
      throw new HttpException(`목업 데이터 주입 실패: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * 이전 회의 데이터 주입 (브리핑 테스트용)
   * POST /room/mock/previous-meeting
   */
  @Post('mock/previous-meeting')
  async injectPreviousMeeting(
    @Body() body: {
      roomId: string;
      meetingTitle: string;
      summary: string;
      keyDecisions: string[];
      actionItems: string[];
      date: string;
    }
  ) {
    const { roomId, meetingTitle, summary, keyDecisions, actionItems, date } = body;

    if (!roomId || !meetingTitle || !summary) {
      throw new HttpException('roomId, meetingTitle, summary가 필요합니다.', HttpStatus.BAD_REQUEST);
    }

    console.log(`\n========== [이전 회의 데이터 주입] ==========`);
    console.log(`Room ID: ${roomId}`);
    console.log(`회의 제목: ${meetingTitle}`);
    console.log(`날짜: ${date}`);

    try {
      // Voice Bot의 Room Context에 이전 회의 데이터 설정
      const result = this.voiceBotService.setPreviousMeetingContext(roomId, {
        meetingTitle,
        summary,
        keyDecisions: keyDecisions || [],
        actionItems: actionItems || [],
        date: date || new Date().toISOString().split('T')[0],
      });

      if (!result.success) {
        throw new HttpException(`방을 찾을 수 없습니다: ${roomId}. 먼저 방에 봇이 입장해야 합니다.`, HttpStatus.NOT_FOUND);
      }

      return {
        success: true,
        roomId,
        message: `이전 회의 "${meetingTitle}" 컨텍스트가 설정되었습니다.`,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error(`[이전 회의 주입 실패] ${error.message}`);
      throw new HttpException(`이전 회의 데이터 주입 실패: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  /**
   * 현재 버퍼 내용 조회 (디버깅용)
   * GET /room/mock/buffer/:roomId
   */
  @Get('mock/buffer/:roomId')
  async getMockBufferContent(@Param('roomId') roomId: string) {
    const content = this.ragClient.getBufferContent(roomId);
    const formatted = this.ragClient.getFormattedTranscript(roomId);

    return {
      roomId,
      statements: content,
      count: content.length,
      formattedTranscript: formatted,
    };
  }

  /**
   * 버퍼 초기화 (시연 리셋용)
   * DELETE /room/mock/buffer/:roomId
   */
  @Delete('mock/buffer/:roomId')
  async clearMockBuffer(@Param('roomId') roomId: string) {
    this.ragClient.clearBuffer(roomId);
    return {
      success: true,
      roomId,
      message: '버퍼가 초기화되었습니다.',
    };
  }

  /**
   * 이전 회의 컨텍스트 조회 (디버깅용)
   * GET /room/mock/previous-meeting/:roomId
   */
  @Get('mock/previous-meeting/:roomId')
  async getMockPreviousMeetingContext(@Param('roomId') roomId: string) {
    const context = this.voiceBotService.getPreviousMeetingContext(roomId);

    if (!context) {
      return {
        roomId,
        hasContext: false,
        message: '이전 회의 컨텍스트가 없습니다.',
      };
    }

    return {
      roomId,
      hasContext: true,
      context,
      briefing: this.voiceBotService.formatPreviousMeetingBriefing(roomId),
    };
  }

  /**
   * 활성 방 목록 조회 (디버깅용)
   * GET /room/mock/active-rooms
   */
  @Get('mock/active-rooms')
  async getActiveRooms() {
    const rooms = this.voiceBotService.getActiveRoomIds();
    return {
      count: rooms.length,
      rooms,
    };
  }

  // ============================================================
  // 일반 라우트 (와일드카드는 맨 아래에)
  // ============================================================

  // 회의 논점 조회 (와일드카드보다 먼저 정의)
  @Get(':roomId/issues')
  async getIssues(
    @Param('roomId') roomId: string,
    @Query('refresh') refresh?: string,
  ) {
    const normalizedRoomId = roomId.trim();
    if (!normalizedRoomId) {
      throw new HttpException('roomId가 필요합니다.', HttpStatus.BAD_REQUEST);
    }

    try {
      const shouldRefresh = refresh === 'true';
      const result = await this.ragClient.getIssues(normalizedRoomId, shouldRefresh);

      if (!result.success) {
        throw new HttpException(result.message || '논점 조회 실패', HttpStatus.BAD_GATEWAY);
      }

      return result.data;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(`논점 조회 실패: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get(':roomId')
  async getRoom(@Param('roomId') roomId: string) {
    return this.livekitService.getRoom(roomId);
  }

  @Delete(':roomId')
  async deleteRoom(@Param('roomId') roomId: string) {
    return this.livekitService.deleteRoom(roomId);
  }

  // 회의 종료 (봇 정리 + RAG 요약 요청)
  @Post('end-meeting')
  async endMeeting(@Body('roomId') roomIdParam: string) {
    const roomId = roomIdParam?.trim();
    if (!roomId) {
      return { status: 'fail', roomId: '' };
    }

    try {
      const result = await this.livekitService.endMeeting(roomId);
      return {
        status: result.success ? 'success' : 'fail',
        roomId: roomId,
        ragResponse: result.message,
      };
    } catch (error) {
      return { status: 'fail', roomId: roomId };
    }
  }

  // 회의 재개 (요약 팝업 닫고 회의 계속할 때 - 대기 모드 해제)
  @Post('resume-meeting')
  async resumeMeeting(@Body('roomId') roomIdParam: string) {
    const roomId = roomIdParam?.trim();
    if (!roomId) {
      return { status: 'fail', roomId: '', message: 'roomId가 필요합니다.' };
    }

    try {
      const result = await this.livekitService.resumeMeeting(roomId);
      return {
        status: result.success ? 'success' : 'fail',
        roomId: roomId,
        message: result.message,
      };
    } catch (error) {
      return { status: 'fail', roomId: roomId, message: error.message };
    }
  }

  // 중간 보고서 요청
  @Post(':roomId/report')
  async requestReport(@Param('roomId') roomId: string) {
    const normalizedRoomId = roomId.trim();
    if (!normalizedRoomId) {
      return { status: 'fail', roomId: '', message: 'roomId가 필요합니다.' };
    }

    try {
      const result = await this.livekitService.requestReport(normalizedRoomId);
      return {
        status: result.success ? 'success' : 'fail',
        roomId: normalizedRoomId,
        message: result.message,
        report: result.report,
      };
    } catch (error) {
      return { status: 'fail', roomId: normalizedRoomId, message: error.message };
    }
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
