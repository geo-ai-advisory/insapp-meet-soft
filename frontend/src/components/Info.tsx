import React from "react";
import { CircleHelp } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./ui/dialog";
import { VisuallyHidden } from "./ui/visually-hidden";
import { About } from "./About";
import { Button } from "./ui/button";

interface InfoProps {
    isCollapsed: boolean;
}

const Info = React.forwardRef<HTMLButtonElement, InfoProps>(({ isCollapsed }, ref) => {
  return (
    <Dialog aria-describedby={undefined}>
      <DialogTrigger asChild>
        {isCollapsed ? (
          <button
            ref={ref}
            className="flex items-center justify-center p-2 hover:bg-secondary rounded-lg transition-colors text-muted-foreground"
            title="О приложении"
          >
            <CircleHelp className="w-5 h-5 stroke-[1.75]" />
          </button>
        ) : (
          <button
            ref={ref}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            title="О приложении"
            aria-label="О приложении"
          >
            <CircleHelp className="h-[17px] w-[17px] stroke-[1.75]" />
          </button>
        )}
      </DialogTrigger>
      <DialogContent>
        <VisuallyHidden>
          <DialogTitle>О приложении Insapp-meet</DialogTitle>
        </VisuallyHidden>
        <About />
      </DialogContent>
    </Dialog>
  );
});

Info.displayName = "Info";

export default Info;
