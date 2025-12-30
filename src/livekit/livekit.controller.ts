import { Controller, Post, Get, Body } from '@nestjs/common';
import { LivekitService } from './livekit.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { JoinRoomDto } from './dto/join-room.dto';

@Controller('rooms')
export class LivekitController {
  constructor(private readonly livekitService: LivekitService) {}

  @Post('create')
  async createRoom(@Body() createRoomDto: CreateRoomDto) {
    return this.livekitService.createRoom(createRoomDto);
  }

  @Post('join')
  async joinRoom(@Body() joinRoomDto: JoinRoomDto) {
    return this.livekitService.generateToken(joinRoomDto);
  }

  @Get('list')
  async listRooms() {
    return this.livekitService.listRooms();
  }
}
