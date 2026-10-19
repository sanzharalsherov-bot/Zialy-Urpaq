import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { JWT_AUDIENCE, JWT_ISSUER } from './auth.security';

@Module({
  imports: [
    PrismaModule,
    JwtModule.registerAsync({
      useFactory: async () => {
        const secret = process.env.JWT_SECRET;
        if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
          throw new Error('JWT_SECRET must be configured with at least 32 bytes');
        }
        return {
          secret,
          signOptions: { expiresIn: '2h', algorithm: 'HS256' as const, issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
          verifyOptions: { algorithms: ['HS256' as const], issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, RolesGuard],
  exports: [JwtModule, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
