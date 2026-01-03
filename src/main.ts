import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Global prefix 설정
  app.setGlobalPrefix('api');

  // CORS 설정
  app.enableCors({
    origin: ['http://localhost:3000', 'https://aura.ai.kr'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`Backend server is running on http://localhost:${port}/api`);
}

bootstrap();
