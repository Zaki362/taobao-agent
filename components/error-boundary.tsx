"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = {
      hasError: false,
      message: ""
    };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error.message || "页面渲染时出现未知错误"
    };
  }

  override render() {
    if (this.state.hasError) {
      return (
        <main className="min-h-screen px-4 py-6 md:px-6">
          <div className="mx-auto flex min-h-[80vh] max-w-[720px] items-center justify-center">
            <Card className="w-full rounded-[30px]">
              <CardHeader>
                <CardTitle>页面渲染出错了</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm leading-7 text-muted-foreground">
                  {this.state.message}
                </p>
                <Button onClick={() => window.location.reload()}>刷新页面</Button>
              </CardContent>
            </Card>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}
