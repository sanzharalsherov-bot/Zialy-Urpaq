import { UserRole } from '@prisma/client';

export interface AuthenticatedUser {
  sub: string;
  email: string;
  role: UserRole;
  kind?: 'shared_student';
  firstName?: string;
  lastName?: string;
  studentProfileId?: string;
}
