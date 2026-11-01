/**
 * AccountsModule — tenancy, sign-in, plans (docs/accounts.md). Global so the
 * turn loop, the agents service and every background sweep can inject
 * AccountsService without importing anything; the auth strategies are
 * provided here and bound in AppModule by AUTH_MODE.
 */
import { Global, Module } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { AuthController } from './auth.controller';
import { AccountController } from './account.controller';
import { SessionAuthStrategy } from './session-auth.strategy';
import { SuiteJwtStrategy } from './suite-jwt.strategy';
import { BILLING_PROVIDER, ManualBillingProvider } from './billing-provider';
import { AgentTypesModule } from '../agent-types/agent-types.module';

@Global()
@Module({
  imports: [AgentTypesModule],
  controllers: [AuthController, AccountController],
  providers: [
    AccountsService,
    SessionAuthStrategy,
    SuiteJwtStrategy,
    // Payments plug in here (Stripe/Paddle implement BillingProvider).
    { provide: BILLING_PROVIDER, useClass: ManualBillingProvider },
  ],
  exports: [AccountsService, SessionAuthStrategy, SuiteJwtStrategy, BILLING_PROVIDER],
})
export class AccountsModule {}
