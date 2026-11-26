// Generated plugin screen search types. Commit this file.
export * from "../api";
type Local1 = { subscriptions: readonly import("../lib/api").Subscription[]; signIns: readonly import("../lib/api").SignIn[] };
type Local2 = import("../lib/api").Subscription["accounts"][number];
type Local3 = { label: () => string; icon: string; tip: () => string; run: () => unknown };
type Local4 = { failed: true; kind: string; data: { message: string; field?: string } };
type Local5 = { threadId: string | undefined };
type Props1 = Extract<NonNullable<{} & { readonly $row: { readonly item: () => import("plugin:agent-proxy/server").SubscriptionView; readonly index: () => number } }>, object>;
type Props2 = Extract<NonNullable<{} & { readonly $row: { readonly item: () => import("plugin:agent-proxy/server").SignInView; readonly index: () => number } }>, object>;
type Props3 = Extract<NonNullable<{ data: Local1 | undefined; returns: import("../pages/subscription").Returns }>, object>;
type Props4 = Extract<NonNullable<{ title: string; count?: number; children?: import("@solidjs/web").JSX.Element }>, object>;
type Props5 = Extract<NonNullable<{
  subscription: import("../lib/api").Subscription;
  data: () => Local1 | undefined;
  returns: import("../pages/subscription").Returns;
}>, object>;
type Props6 = Extract<NonNullable<Props5 & { readonly $row: { readonly item: () => { id: string; email?: string | undefined; organization?: string | undefined; status: "ok" | "signed-out"; reason?: string | undefined; }; readonly index: () => number } }>, object>;
type Props7 = Extract<NonNullable<{
  account: Local2;
  onSignOut: () => Promise<unknown>;
  onSignIn: () => Promise<unknown>;
}>, object>;
type Props8 = Extract<NonNullable<{ subscription: import("../lib/api").Subscription }>, object>;
type Props9 = Extract<NonNullable<{ title: string }>, object>;
type Props10 = Extract<NonNullable<Props8 & { readonly $row: { readonly item: () => { id: string; name: string; }; readonly index: () => number } }>, object>;
type Props11 = Extract<NonNullable<Props8 & { readonly $row: { readonly item: () => import("../../server/profile-uses").ProfileUse; readonly index: () => number } }>, object>;
type Props12 = Extract<NonNullable<import("../ui/add-dialog").AddDialogProps>, object>;
type Props13 = Extract<NonNullable<{ step: keyof typeof STEPS; mark?: import("../lib/api").Company; children: import("@solidjs/web").JSX.Element }>, object>;
type Props14 = Extract<NonNullable<Props13 & { readonly $row: { readonly item: number; readonly index: () => number } }>, object>;
type Props15 = Extract<NonNullable<{ message: string | undefined }>, object>;
type Props16 = Extract<NonNullable<{ onPick: (company: import("../lib/api").Company) => void }>, object>;
type Props17 = Extract<NonNullable<Props16 & { readonly $row: { readonly item: "anthropic" | "openai"; readonly index: () => number } }>, object>;
type Props18 = Extract<NonNullable<{
  company: import("../lib/api").Company;
  start: () => Promise<unknown>;
  onBack: () => void;
}>, object>;
type Props19 = Extract<NonNullable<{
  signIn: import("../lib/api").SignIn;
  listening: boolean;
  returned: { address: string; problem?: string } | undefined;
  finish: (pasted: string) => Promise<unknown>;
  restart: () => Promise<unknown>;
  copy?: (text: string) => Promise<void>;
}>, object>;
type Props20 = Extract<NonNullable<{
  subscription: import("../lib/api").Subscription;
  done: (label: string) => Promise<unknown>;
}>, object>;
type Props21 = Extract<NonNullable<Props20 & { readonly $row: { readonly item: { id: string; name: string; }; readonly index: () => number } }>, object>;
type Props22 = Extract<NonNullable<Local3>, object>;
type Props23 = Extract<NonNullable<{
  subscription: import("../lib/api").Subscription;
  /** "Add to profile" (TKM-264), before Remove. */
  addToProfile?: import("@solidjs/web").JSX.Element;
}>, object>;
type Props24 = Extract<NonNullable<{ subscription: import("../lib/api").Subscription; builder: import("../lib/builder").Builder }>, object>;
type Props25 = Extract<NonNullable<Props24 & { readonly $row: { readonly item: string; readonly index: () => number } }>, object>;
type Props26 = Extract<NonNullable<Props24 & { readonly $row: { readonly item: () => import("../../server/profiles").ProfileView; readonly index: () => number } }>, object>;
type Props27 = Extract<NonNullable<{
  company: import("../lib/api").Company;
  size: keyof typeof sizes;
  class?: string;
}>, object>;
type Props28 = Extract<NonNullable<Props27 & { readonly $row: { readonly item: { d: string; fillRule?: "evenodd" | "nonzero" | undefined; }; readonly index: () => number } }>, object>;
type Props29 = Extract<NonNullable<{
  profile: import("../lib/builder").Profile;
  builder: import("../lib/builder").Builder;
  subscriptions: ReadonlyMap<string, import("../lib/api").Subscription>;
}>, object>;
type Props30 = Extract<NonNullable<Props29 & { readonly $row: { readonly item: string; readonly index: () => number } }>, object>;
type Props31 = Extract<NonNullable<{ position: number }>, object>;
type Props32 = Extract<NonNullable<{
  profile: import("../lib/builder").Profile;
  builder: import("../lib/builder").Builder;
  subscription: import("../lib/api").Subscription | undefined;
  id: string;
  position: number;
  count: number;
}>, object>;
type Props33 = Extract<NonNullable<{
  open: boolean;
  onClose: () => void;
  create: (name: string, code: string) => Promise<import("../lib/builder").Profile | Local4>;
}>, object>;
type Props34 = Extract<NonNullable<{
  builder: import("../lib/builder").Builder;
  subscriptions: readonly import("../lib/api").Subscription[];
}>, object>;
type Props35 = Extract<NonNullable<Props34 & { readonly $row: { readonly item: () => import("../../server/profiles").ProfileView; readonly index: () => number } }>, object>;
type Props36 = Extract<NonNullable<{ subscriptions: readonly import("../lib/api").Subscription[] }>, object>;
type Props37 = Extract<NonNullable<{
  subscription: import("../lib/api").Subscription;
  now: number;
  onEnabled: (enabled: boolean) => void;
  onSignIn: () => Promise<unknown>;
  /** The row of icon buttons under the card's lines. */
  actions?: import("@solidjs/web").JSX.Element;
  /** Faded: a pointed-at profile does not hold it, or it is the card being dragged. */
  dimmed?: boolean;
  /** The end of the model line: the codes of the profiles that use it. */
  profiles?: import("@solidjs/web").JSX.Element;
  /** Starts dragging the card into a profile. */
  onPointerDown?: (event: PointerEvent) => void;
}>, object>;
type Props38 = Extract<NonNullable<Props37 & { readonly $row: { readonly item: () => { id: string; email?: string | undefined; organization?: string | undefined; status: "ok" | "signed-out"; reason?: string | undefined; }; readonly index: () => number } }>, object>;
type Props39 = Extract<NonNullable<{
  signIn: import("../lib/api").SignIn;
  onContinue: () => void;
  onCancel: () => Promise<unknown>;
  onRestart: () => Promise<unknown>;
  /** Faded while a profile is pointed at: a sign-in is in no profile. */
  dimmed?: boolean;
}>, object>;
type Props40 = Extract<NonNullable<{ code?: string }>, object>;
type Props41 = Extract<NonNullable<Local5 & {
    refreshCatalog: () => void;
    resetCatalog: () => void;
  }>, object>;
type Props42 = Extract<NonNullable<Local5>, object>;
type Props43 = Extract<NonNullable<Props42 & { readonly $row: { readonly item: () => import("../../server/profiles").ProfileView; readonly index: () => number } }>, object>;
type Props44 = Extract<NonNullable<import("plugin:chat/client").ThreadRowProps>, object>;
export declare const find: import("@tokamak/sdk/client").ScreenFind<{
  "div": [["Profiles", {}], ["Profiles" | "div" | "section", {}], ["SectionHeader", Props4], ["Details" | "section", Props5], ["Details" | "section", Props5], ["Details" | "section" | "div", Props5], ["AccountRow" | "li", Props7], ["AddDialog" | "Dialog.Root" | "Dialog.Content", Props12], ["Header", Props13], ["Header" | "div", Props13, {"role":"img"}], ["CompanyStep", Props16], ["CompanyStep" | "div", Props16, {"role":"separator"}], ["CompanyStep" | "div", Props16], ["MethodStep", Props18], ["MethodStep" | "div", Props18], ["MethodStep" | "div", Props18, {"aria":{"disabled":"true"}}], ["MethodStep", Props18], ["SignInStep", Props19], ["SignInStep", Props19], ["SignInStep" | "form", Props19], ["ConnectedStep", Props20], ["ConnectedStep" | "div", Props20], ["ConnectedStep", Props20], ["ConnectedStep" | "form", Props20], ["ConnectedStep" | "form", Props20], ["CardActions", Props23], ["CardActions" | "div", Props23, {"role":"toolbar"}], ["ProfileDialog" | "Dialog.Root" | "Dialog.Content" | "form", Props33], ["ProfileDialog" | "Dialog.Root" | "Dialog.Content" | "form", Props33], ["ProfileDialog" | "Dialog.Root" | "Dialog.Content" | "form", Props33], ["ProfileDialog" | "Dialog.Root" | "Dialog.Content" | "form", Props33], ["ProfilesSection" | "section" | "header", Props34], ["ProfilesSection" | "section", Props34], ["Ghost", Props24, {"aria":{"hidden":"true"}}], ["Confirm", Props8], ["Confirm", Props8], ["SubscriptionCard" | "article", Props37], ["SubscriptionCard" | "article" | "div", Props37], ["SubscriptionCard" | "article", Props37], ["SubscriptionCard" | "article", Props37], ["SubscriptionCard" | "article", Props37], ["SubscriptionCard" | "article", Props37], ["AwaitingCard" | "article", Props39], ["AwaitingCard" | "article" | "div", Props39], ["AwaitingCard" | "article" | "div", Props39], ["PickerProfileColumn" | "Menu.RadioGroup", Props42]];
  "SubscriptionDetails": {};
  "section": [["Profiles" | "div", {}, {"aria":{"label":"Subscriptions"}}], ["Details", Props5], ["Details" | "section" | "div", Props5, {"aria":{"label":"Accounts"}}], ["Label", Props8, {"aria":{"label":"Label"}}], ["Models", Props8, {"aria":{"label":"Models"}}], ["UsedBy", Props8, {"aria":{"label":"Used by"}}], ["ProfileBox", Props29], ["ProfilesSection", Props34, {"aria":{"label":"Profiles"}}]];
  "header": [["Profiles" | "div" | "section", {}], ["ProfileBox" | "section", Props29], ["ProfilesSection" | "section", Props34]];
  "h2": [["Profiles" | "div" | "section" | "header", {}], ["Details" | "section" | "div", Props5], ["ProfilesSection" | "section" | "header" | "div", Props34]];
  "span": [["Profiles" | "div" | "section" | "header" | "h2", {}], ["Profiles" | "div" | "section" | "header" | "h2", {}], ["SectionHeader" | "div" | "h3", Props4], ["Details" | "section" | "div", Props5], ["AccountRow" | "li" | "div", Props7], ["AccountRow" | "li" | "div", Props7], ["AccountRow" | "li" | "div", Props7], ["AccountRow" | "li" | "div" | "span", Props7], ["Breadcrumb" | "Region.Header" | "nav", Props9, {"aria":{"hidden":"true"}}], ["Models" | "section" | "SectionHeader", Props8], ["UsedBy" | "section" | "ul" | "li", Props11], ["UsedBy" | "section" | "ul" | "li" | "span", Props11], ["UsedBy" | "section" | "ul" | "li", Props11], ["UsedBy" | "section" | "ul" | "li", Props11], ["Header" | "div", Props14], ["CompanyStep" | "div" | "Row", Props16], ["SignInStep" | "div", Props19], ["SignInStep" | "sign-in-help", Props19], ["ConnectedStep" | "div", Props20], ["ConnectedStep" | "div", Props20], ["ConnectedStep" | "div", Props20], ["CardActions" | "div", Props23], ["CardProfiles", Props24], ["CardProfiles" | "span", Props25], ["CardProfiles" | "span", Props24], ["AddToProfile" | "Menu.Root" | "Menu.Content" | "Menu.Group" | "Menu.Item", Props26], ["AddToProfile" | "Menu.Root" | "Menu.Content" | "Menu.Group" | "Menu.Item", Props26], ["AddToProfile" | "Menu.Root" | "Menu.Content" | "Menu.Group" | "Menu.Item", Props26], ["ProfileBox" | "section" | "header" | "h3", Props29], ["ProfileBox" | "section" | "header" | "h3", Props29], ["ProfileBox" | "section" | "header", Props29], ["ProfileBox" | "section" | "header", Props29], ["Entry" | "li", Props32], ["Entry" | "li", Props32], ["Entry" | "li", Props32], ["Entry" | "li", Props32], ["ProfilesSection" | "section" | "header" | "div" | "h2", Props34], ["ProfilesSection" | "section" | "header" | "div" | "h2", Props34], ["Ghost" | "div", Props24], ["Ghost" | "div" | "span", Props24], ["Ghost" | "div" | "span", Props24], ["Ghost" | "div", Props24], ["Confirm" | "div" | "ul" | "li", Props11], ["Confirm" | "div" | "ul" | "li", Props11], ["SubscriptionCard" | "article" | "div", Props37], ["SubscriptionCard" | "article" | "div", Props37], ["SubscriptionCard" | "article" | "div", Props38], ["SubscriptionCard" | "article" | "div", Props37], ["SubscriptionCard" | "article" | "div", Props37], ["SubscriptionCard" | "article" | "div", Props37], ["SubscriptionCard" | "article" | "div", Props37], ["AwaitingCard" | "article", Props39], ["AwaitingCard" | "article" | "div", Props39], ["AwaitingCard" | "article" | "div", Props39], ["AwaitingCard" | "article" | "div", Props39], ["PickerProfileChip", Props41], ["PickerProfileStatus", Props42, {"role":"status"}], ["PickerProfileColumn" | "Menu.RadioGroup" | "Menu.RadioItem", Props43], ["PickerProfileColumn" | "Menu.RadioGroup", Props42, {"role":"alert"}]];
  "Button": [["Profiles" | "div" | "section" | "header", {}], ["Details" | "section" | "div" | "SectionHeader", Props5], ["AccountRow" | "li", Props7], ["AccountRow" | "li", Props7], ["Breadcrumb" | "Region.Header" | "nav", Props9], ["MethodStep" | "div", Props18], ["SignInStep" | "div", Props19], ["SignInStep" | "div", Props19], ["SignInStep" | "div", Props19], ["SignInStep" | "form" | "div", Props19, {"type":"submit"}], ["ConnectedStep" | "form" | "div", Props20, {"type":"submit"}], ["ProfileDialog" | "Dialog.Root" | "Dialog.Content" | "form" | "div", Props33, {"type":"submit"}], ["ProfilesSection" | "section" | "header", Props34], ["Confirm" | "div", Props8], ["SubscriptionCard" | "article" | "div", Props37], ["AwaitingCard" | "article" | "div", Props39], ["AwaitingCard" | "article" | "div", Props39], ["AwaitingCard" | "article" | "div", Props39]];
  "p": [["Profiles" | "div" | "section", {}, {"role":"alert"}], ["Profiles" | "div" | "section", {}], ["Details" | "section", Props5, {"role":"alert"}], ["UsedBy" | "section", Props8], ["Problem", Props15, {"role":"alert"}], ["CardActions" | "div", Props23, {"role":"alert"}], ["ProfileBox" | "section", Props29], ["ProfilesSection" | "section" | "header" | "div", Props34], ["ProfilesSection" | "section", Props34, {"role":"alert"}], ["ProfilesSection" | "section", Props34], ["ProfilesSection" | "section", Props34, {"aria":{"live":"polite"}}], ["Confirm", Props8], ["Confirm" | "div", Props8], ["Confirm", Props8, {"role":"alert"}]];
  "SubscriptionCard": Props1;
  "CardActions": Props1;
  "AddToProfile": Props1;
  "CardProfiles": Props1;
  "AwaitingCard": Props2;
  "ProfilesSection": {};
  "RemoveDialog": {};
  "AddDialog": [["Profiles" | "div", {}], ["Details", Props5]];
  "Details": Props3;
  "h3": [["SectionHeader" | "div", Props4], ["ProfileBox" | "section" | "header", Props29]];
  "Breadcrumb": Props5;
  "CompanyMark": [["Details" | "section" | "div", Props5], ["Header" | "div", Props13], ["CompanyStep" | "div" | "Row", Props17], ["ConnectedStep" | "div", Props20], ["Entry" | "li", Props32], ["Ghost" | "div", Props24], ["SubscriptionCard" | "article" | "div", Props37], ["AwaitingCard" | "article" | "span", Props39], ["PickerProfileColumn" | "Menu.RadioGroup" | "Menu.RadioItem", Props43]];
  "SectionHeader": [["Details" | "section" | "div", Props5], ["Label" | "section", Props8], ["Models" | "section", Props8], ["UsedBy" | "section", Props8]];
  "ul": [["Details" | "section" | "div", Props5], ["Models" | "section", Props8], ["UsedBy" | "section", Props8], ["ConnectedStep" | "div", Props20, {"aria":{"label":"Models"}}], ["Confirm" | "div", Props8, {"aria":{"label":"Profiles that lose it"}}]];
  "AccountRow": Props6;
  "Label": Props5;
  "Models": Props5;
  "UsedBy": Props5;
  "li": [["AccountRow", Props7], ["Models" | "section" | "ul", Props10], ["UsedBy" | "section" | "ul", Props11], ["ConnectedStep" | "div" | "ul", Props21], ["DropSlot", Props31, {"aria":{"hidden":"true"}}], ["Entry", Props32], ["Confirm" | "div" | "ul", Props11]];
  "Avatar": Props7;
  "form": [["Label" | "section", Props8], ["SignInStep", Props19], ["ConnectedStep", Props20], ["ProfileDialog" | "Dialog.Root" | "Dialog.Content", Props33]];
  "Input": [["Label" | "section" | "form", Props8, {"aria":{"label":"Label","describedby":"label-problem"}}], ["SignInStep" | "form" | "div", Props19, {"aria":{"label":"Address the sign-in ended on"}}]];
  "label-problem": [["Label" | "section" | "form", Props8, {"role":"alert"}]];
  "Region.Header": Props9;
  "nav": [["Breadcrumb" | "Region.Header", Props9, {"aria":{"label":"Breadcrumb"}}]];
  "h1": Props9;
  "Chip": [["Models" | "section" | "ul" | "li", Props10], ["ConnectedStep" | "div" | "ul" | "li", Props21], ["ProfileCode", Props40]];
  "Icon": [["UsedBy" | "section" | "ul" | "li" | "span", Props11], ["CompanyStep" | "div" | "Row", Props17], ["MethodStep" | "div" | "Row", Props18], ["MethodStep" | "div" | "Row", Props18], ["MethodStep" | "div" | "Row", Props18], ["SignInStep" | "sign-in-help" | "span", Props19], ["ConnectedStep" | "div", Props20], ["CardProfiles" | "span", Props25], ["ProfileBox" | "section" | "header", Props29], ["ProfileBox" | "section" | "header" | "span", Props29], ["Entry" | "li", Props32], ["Confirm" | "div" | "ul" | "li", Props11], ["SubscriptionCard" | "article" | "div", Props37], ["SubscriptionCard" | "article" | "div", Props37], ["AwaitingCard" | "article" | "div" | "span", Props39], ["PickerProfileColumn" | "Menu.RadioGroup" | "Menu.RadioItem", Props43]];
  "Dialog.Root": [["AddDialog", Props12], ["ProfileDialog", Props33], ["RemoveDialog", Props36]];
  "Dialog.Backdrop": [["AddDialog" | "Dialog.Root", Props12], ["ProfileDialog" | "Dialog.Root", Props33], ["RemoveDialog" | "Dialog.Root", Props36]];
  "Dialog.Content": [["AddDialog" | "Dialog.Root", Props12], ["ProfileDialog" | "Dialog.Root", Props33], ["RemoveDialog" | "Dialog.Root", Props36]];
  "CompanyStep": Props12;
  "MethodStep": Props12;
  "SignInStep": Props12;
  "ConnectedStep": Props12;
  "Dialog.Title": [["Header" | "div", Props13], ["ProfileDialog" | "Dialog.Root" | "Dialog.Content" | "form" | "div", Props33], ["Confirm", Props8]];
  "Dialog.Close": [["Header" | "div", Props13], ["ProfileDialog" | "Dialog.Root" | "Dialog.Content" | "form" | "div", Props33], ["ProfileDialog" | "Dialog.Root" | "Dialog.Content" | "form" | "div", Props33], ["Confirm" | "div", Props8]];
  "Header": [["CompanyStep", Props16], ["MethodStep", Props18], ["SignInStep", Props19], ["ConnectedStep", Props20]];
  "Row": [["CompanyStep" | "div", Props17], ["CompanyStep" | "div", Props16], ["MethodStep" | "div", Props18], ["MethodStep" | "div", Props18]];
  "Problem": [["MethodStep", Props18], ["SignInStep" | "div", Props19], ["SignInStep" | "form", Props19], ["ConnectedStep" | "form" | "div", Props20]];
  "a": Props19;
  "sign-in-help": Props19;
  "paste-help": Props19;
  "label": [["ConnectedStep" | "form" | "div", Props20], ["ProfileDialog" | "Dialog.Root" | "Dialog.Content" | "form" | "div", Props33], ["ProfileDialog" | "Dialog.Root" | "Dialog.Content" | "form" | "div", Props33]];
  "subscription-label": Props20;
  "Tooltip.Root": [["CardActions" | "button", Props22], ["AddToProfile" | "Menu.Root", Props24]];
  "Tooltip.Trigger": [["CardActions" | "button" | "Tooltip.Root", Props22], ["AddToProfile" | "Menu.Root" | "Tooltip.Root", Props24]];
  "Tooltip.Content": [["CardActions" | "button" | "Tooltip.Root", Props22], ["AddToProfile" | "Menu.Root" | "Tooltip.Root", Props24]];
  "Menu.Root": [["AddToProfile", Props24], ["Entry" | "li" | "span", Props32]];
  "Menu.Trigger": [["AddToProfile" | "Menu.Root" | "Tooltip.Root" | "Tooltip.Trigger", Props24], ["Entry" | "li" | "span" | "Menu.Root", Props32]];
  "Menu.Content": [["AddToProfile" | "Menu.Root", Props24], ["Entry" | "li" | "span" | "Menu.Root", Props32]];
  "Menu.Group": Props24;
  "Menu.GroupLabel": Props24;
  "Menu.Item": [["AddToProfile" | "Menu.Root" | "Menu.Content" | "Menu.Group", Props26], ["AddToProfile" | "Menu.Root" | "Menu.Content" | "Menu.Group", Props24], ["Entry" | "li" | "span" | "Menu.Root" | "Menu.Content", Props32], ["Entry" | "li" | "span" | "Menu.Root" | "Menu.Content", Props32], ["Entry" | "li" | "span" | "Menu.Root" | "Menu.Content", Props32]];
  "svg": [["CompanyMark", Props27, {"aria":{"hidden":"true"}}]];
  "path": Props28;
  "ol": Props29;
  "DropSlot": [["ProfileBox" | "section" | "ol", Props30], ["ProfileBox" | "section" | "ol", Props29]];
  "Entry": Props30;
  "Menu.Separator": Props32;
  "profile-name": [["ProfileDialog" | "Dialog.Root" | "Dialog.Content" | "form" | "div", Props33, {"aria":{"describedby":"profile-problem"}}]];
  "profile-code": [["ProfileDialog" | "Dialog.Root" | "Dialog.Content" | "form" | "div", Props33, {"aria":{"describedby":"profile-code-help profile-problem"}}]];
  "profile-code-help": Props33;
  "profile-problem": [["ProfileDialog" | "Dialog.Root" | "Dialog.Content" | "form", Props33, {"role":"alert"}]];
  "ProfileBox": Props35;
  "Ghost": Props34;
  "ProfileDialog": Props34;
  "Confirm": Props36;
  "Dialog.Description": Props8;
  "article": [["SubscriptionCard", Props37], ["AwaitingCard", Props39]];
  "Switch": Props37;
  "ProfileCode": [["PickerProfileChip" | "span", Props41], ["ThreadProfile", Props44], ["IdleThreadProfile", Props44]];
  "Menu.RadioGroup": [["PickerProfileColumn", Props42, {"aria":{"label":"Profile"}}]];
  "Menu.RadioItem": Props43;
  "SavedAgentDetail": Props44;
}>;
