import axios from "axios";
import { Logger } from "./logger";

interface AddressEntry {
  address: string;
  comment?: string;
  date?: string;
}

export class AddressListService {
  private static instance: AddressListService;
  private darklist: Set<string> = new Set();
  private lightlist: Set<string> = new Set();
  private lastUpdate: Date | null = null;

  private constructor() {}

  public static getInstance(): AddressListService {
    if (!AddressListService.instance) {
      AddressListService.instance = new AddressListService();
    }
    return AddressListService.instance;
  }

  public async initialize() {
    try {
      const [darklistResponse, lightlistResponse] = await Promise.all([
        axios.get<AddressEntry[]>(
          "https://raw.githubusercontent.com/MyEtherWallet/ethereum-lists/master/src/addresses/addresses-darklist.json"
        ),
        axios.get<AddressEntry[]>(
          "https://raw.githubusercontent.com/MyEtherWallet/ethereum-lists/master/src/addresses/addresses-lightlist.json"
        ),
      ]);

      this.darklist = new Set(
        darklistResponse.data.map((entry) => entry.address.toLowerCase())
      );
      this.lightlist = new Set(
        lightlistResponse.data.map((entry) => entry.address.toLowerCase())
      );
      this.lastUpdate = new Date();

      Logger.info("address-lists", "Successfully initialized address lists", {
        darklistSize: this.darklist.size,
        lightlistSize: this.lightlist.size,
      });
    } catch (error) {
      Logger.error("address-lists", "Failed to initialize address lists", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  public isDarklisted(address: string): boolean {
    return this.darklist.has(address.toLowerCase());
  }

  public isLightlisted(address: string): boolean {
    return this.lightlist.has(address.toLowerCase());
  }
}
