/**
 * Host inventory — the static + slow-changing capability set of a GPU host.
 * Reported on handshake and refreshed whenever the agent detects hardware
 * changes (driver update, MIG reconfigure, etc.).
 */

export interface GpuDeviceInventory {
  /** Stable PCI / nvidia-smi index. */
  index: number;
  /** UUID reported by `nvidia-smi`. Stable across reboots, unique per card. */
  uuid: string;
  /** e.g. "NVIDIA A100 80GB PCIe". */
  productName: string;
  /** VRAM in MiB. */
  memoryTotalMiB: number;
  /** Whether MIG mode is currently enabled on the device. */
  migEnabled: boolean;
  /** Whether the device supports MIG at all. */
  migCapable: boolean;
  /** Reported compute capability ("8.0", "9.0", …). */
  computeCapability: string | null;
}

export interface SystemInventory {
  /** Kernel + distro identification. */
  os: {
    platform: string;
    release: string;
    distro: string | null;
    arch: string;
  };
  cpu: {
    model: string;
    cores: number;
    threads: number;
  };
  memoryTotalMiB: number;
  /** Resolved versions for the tooling the agent depends on. */
  toolchain: {
    nvidiaDriver: string | null;
    cuda: string | null;
    docker: string | null;
    nvidiaContainerToolkit: string | null;
    agent: string;
  };
}

/**
 * What kind of accelerator the agent found, if any. Drives runtime selection
 * (e.g. vLLM needs nvidia-gpu, Ollama can run on apple-silicon or cpu).
 */
export type AcceleratorKind = 'nvidia-gpu' | 'apple-silicon' | 'amd-gpu' | 'cpu';
export type GpuFrameworkKind = 'cuda' | 'rocm' | 'metal' | 'none';

export interface HostInventory {
  /** Human-friendly host name (defaults to OS hostname; admin can rename). */
  hostname: string;
  system: SystemInventory;
  gpus: GpuDeviceInventory[];
  /** Best primary accelerator on this host. `cpu` when there is no GPU. */
  accelerator: AcceleratorKind;
  /** Resolved framework matching the accelerator. */
  gpuFramework: GpuFrameworkKind;
  /**
   * The IPv4/host the console + pool proxy should use to reach this host's
   * containers. Agent suggests this (first non-loopback NIC); admin can
   * override at claim time.
   */
  preferredServiceAddress: string | null;
  /** Free-form labels the admin can attach (region=eastus, tier=test). */
  labels: Record<string, string>;
  /** Cloud provider hint, when detectable from instance metadata. */
  cloud:
    | {
        provider: 'azure' | 'aws' | 'gcp' | 'self';
        region?: string;
        vmSize?: string;
        instanceId?: string;
        /**
         * Address rendering of the VM's two natures:
         *   - `privateIp`: VNet-scoped — what other VMs in the same VNet hit
         *   - `publicIp`: the externally routable address, if assigned
         * Either or both may be null. `preferredServiceAddress` above is the
         * agent's best-guess single value: publicIp when present, otherwise
         * privateIp, otherwise a local-NIC fallback.
         */
        privateIp?: string | null;
        publicIp?: string | null;
      }
    | null;
}
