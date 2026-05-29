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
            className="flex items-center justify-center p-2 hover:bg-gray-100 rounded-lg transition-colors text-gray-600"
            title="О приложении"
          >
            <CircleHelp className="w-5 h-5 stroke-[1.75]" />
          </button>
        ) : (
          <Button
            ref={ref}
            variant="secondary"
            className="w-full"
            title="О приложении Insapp-meet"
          >
            <CircleHelp />
            О приложении
          </Button>
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
