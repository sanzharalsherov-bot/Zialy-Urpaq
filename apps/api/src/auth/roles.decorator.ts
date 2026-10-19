import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export const ROLES_KEY = 'required_roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
