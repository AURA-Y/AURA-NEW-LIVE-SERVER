import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { LivekitService } from './livekit.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { JoinRoomDto } from './dto/join-room.dto';

@Controller('room')
export class LivekitController {
  constructor(private readonly livekitService: LivekitService) {}

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
}

@Controller()
export class ApiController {
  constructor(private readonly livekitService: LivekitService) {}

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
