import type { ProviderDomain } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import type { LooseProviderContract, ProviderContract, ProviderDescriptor } from './types';
import { CORE_PROVIDER_CONTRACTS } from './contracts';

const logger = createLogger('provider-registry');

class ProviderRegistry {
  private contracts = new Map<string, LooseProviderContract>();
  private initialised = false;

  private ensureInitialised() {
    if (this.initialised) {
      return;
    }

    CORE_PROVIDER_CONTRACTS.forEach((contract) => {
      this.register(contract);
    });

    this.initialised = true;
  }

  register(contract: LooseProviderContract): void {
    if (this.contracts.has(contract.id)) {
      const existing = this.contracts.get(contract.id);
      if (existing?.version !== contract.version) {
        logger.warn(`Provider contract with id "${contract.id}" already registered (version ${existing?.version}). Skipping new version ${contract.version}.`);
      }
      return;
    }

    this.contracts.set(contract.id, contract);
  }

  registerMany(contracts: LooseProviderContract[]): void {
    contracts.forEach((contract) => this.register(contract));
  }

  listDescriptors(domain?: ProviderDomain): ProviderDescriptor[] {
    this.ensureInitialised();
    return Array.from(this.contracts.values())
      .filter((contract) =>
        domain ? contract.domains.includes(domain) : true,
      )
      .map((contract) => ({
        id: contract.id,
        version: contract.version,
        domains: contract.domains,
        display: contract.display,
        capabilities: contract.capabilities,
      }));
  }

  getContract<TContract extends ProviderContract>(id: string): TContract {
    this.ensureInitialised();
    const contract = this.contracts.get(id);
    if (!contract) {
      throw new Error(`Provider contract with id "${id}" not found.`);
    }
    return contract as TContract;
  }

  async createRuntime<TRuntime>(
    id: string,
    context: Parameters<ProviderContract<TRuntime>['createRuntime']>[0],
  ): Promise<TRuntime> {
    const contract = this.getContract<ProviderContract<TRuntime>>(id);
    return contract.createRuntime(context);
  }

  getFormSchema(id: string) {
    const contract = this.getContract(id);
    return contract.form;
  }
}

export const providerRegistry = new ProviderRegistry();

export function registerProvider(contract: LooseProviderContract): void {
  providerRegistry.register(contract);
}

export function registerProviders(contracts: LooseProviderContract[]): void {
  providerRegistry.registerMany(contracts);
}

export type { ProviderRegistry };
